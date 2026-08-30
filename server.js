try {
  require("dotenv").config({ path: "./.env" });
} catch {
  try {
    const envFs = require("fs");
    const envPath = require("path").resolve(process.cwd(), ".env");
    if (envFs.existsSync(envPath)) {
      envFs.readFileSync(envPath, "utf8").split(/\r?\n/).forEach((line) => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) {
          return;
        }
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      });
    }
  } catch {}
}
require("./services/envCompatibility").applyBrandEnvCompatibility();
const managedRuntime = [
  process.env.RENDER,
  process.env.RENDER_SERVICE_ID,
  process.env.RENDER_SERVICE_NAME,
  process.env.RENDER_EXTERNAL_URL,
  process.env.RENDER_INSTANCE_ID,
].some((value) => String(value || "").trim()) || /^(?:\/opt\/render\/|\/app(?:\/|$))/.test(process.cwd().replaceAll("\\", "/"));
if (managedRuntime && String(process.env.NODE_ENV || "").toLowerCase() !== "test") process.env.NODE_ENV = "production";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const webPush = require("web-push");

const uploadsDir = path.resolve(process.env.DELIVERA_UPLOAD_DIR || path.join(__dirname, "uploads"));
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
const { URL } = require("url");
const dbFacade = require("./db");
const { getDb, resolveDbFile, redisSync } = dbFacade;
const { runMigrations } = require("./scripts/migrate");
const { getPlatformAdapter, normalizePlatformKey } = require("./platform-adapters");
const platformConnectors = require("./connectors");
const logger = require("./services/logger");
const { createPlatformService } = require("./services/platformService");
const { createRateLimitStore } = require("./services/rateLimitStore");
const { createQueueService, JOB_TYPES } = require("./services/queueService");
const { createSessionRevocationService } = require("./services/sessionRevocationService");
const { sendPlatformStatusCallback, callbackOutcomeAlreadyRecorded } = require("./services/platformCallbackService");
const posentegraClient = require("./services/posentegraClient");
const { createPosentegraOutboxService } = require("./services/posentegraOutboxService");
const {
  createConnectionHealthService,
  HEALTH_STATUS,
  HEALTH_ERROR_CODES,
  buildHealthPayload,
  normalizeErrorCode,
} = require("./services/connectionHealthService");
const { verifyPlatformSignature } = require("./services/platformSignature");
const { mapOrderStatus } = require("./utils/orderStatusMapper");
const { createTelegramService } = require("./services/telegramService");
const { createOperationsSupervisor } = require("./services/operationsSupervisor");

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = resolveDbFile();
const LOG_DIR = path.join(__dirname, "logs");
const WEBHOOK_LOG_FILE = path.join(LOG_DIR, "webhooks.log");
const ADMIN_BOOTSTRAP_FILE = path.join(LOG_DIR, "admin-bootstrap.txt");
const PASSWORD_RESET_LOG_FILE = path.join(LOG_DIR, "password-resets.log");
const RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RESTAURANT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const COURIER_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_REFRESH_TOKEN_MAX_AGE_MS = Math.max(
  REFRESH_TOKEN_MAX_AGE_MS,
  (Number(process.env.DELIVERA_ADMIN_REFRESH_DAYS) || 365) * 24 * 60 * 60 * 1000
);
const PASSWORD_RESET_MAX_AGE_MS = 20 * 60 * 1000;
const PLATFORM_VERIFY_TIMEOUT_MS = 8_000;
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
const PUBLIC_BASE_URL = trimmed(process.env.PUBLIC_BASE_URL).replace(/\/+$/, "");
const CORS_ALLOWED_ORIGINS = String(process.env.DELIVERA_CORS_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => {
    const trimmedOrigin = origin.trim().replace(/\/+$/, "");
    if (!trimmedOrigin) return null;
    try {
      const url = new URL(trimmedOrigin.startsWith("http") ? trimmedOrigin : `https://${trimmedOrigin}`);
      return url.origin;
    } catch {
      logger.warn("Invalid CORS origin configured", { origin: trimmedOrigin });
      return null;
    }
  })
  .filter(Boolean);
const TRUST_PROXY = ["1", "true", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());
const FORCE_HTTPS = ["1", "true", "yes"].includes(String(process.env.FORCE_HTTPS || "").toLowerCase());
const REDIS_URL = trimmed(process.env.REDIS_URL || process.env.DELIVERA_REDIS_URL);
const WEBHOOK_SECRET = trimmed(process.env.WEBHOOK_SECRET);
const WEBHOOK_ENABLED = !["0", "false", "no"].includes(String(process.env.WEBHOOK_ENABLED || "true").toLowerCase());
const WEBHOOK_LOG_ENABLED = !["0", "false", "no"].includes(String(process.env.WEBHOOK_LOG_ENABLED || "true").toLowerCase());
const LOG_PASSWORD_RESET_TOKENS = !IS_PRODUCTION && ["1", "true", "yes"].includes(String(process.env.DELIVERA_LOG_PASSWORD_RESET_TOKENS || "").toLowerCase());
const MAX_REQUEST_BODY_BYTES = Math.max(64 * 1024, Math.min(5 * 1024 * 1024, Number(process.env.DELIVERA_MAX_REQUEST_BODY_BYTES || 1024 * 1024)));
const METRICS_TOKEN = trimmed(process.env.DELIVERA_METRICS_TOKEN);
const CURTAIN_SETTINGS_ID = "system_curtain";
const CURTAIN_CONTROL_TOKEN_HASH = trimmed(process.env.DELIVERA_CURTAIN_TOKEN_SHA256) ||
  "4dfe961206fd6af4f11d0dd6d9a717d9d9668465b96d8f5e4a7b6a8f649b7d7b";
const WEBHOOK_ALLOWED_IPS = String(process.env.WEBHOOK_ALLOWED_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);
const RATE_LIMITS = {
  integrations: { limit: 100, windowMs: RATE_LIMIT_WINDOW_MS },
  courierLogin: { limit: 10, windowMs: RATE_LIMIT_WINDOW_MS },
  adminLogin: { limit: 5, windowMs: RATE_LIMIT_WINDOW_MS },
  restaurantLogin: { limit: 20, windowMs: RATE_LIMIT_WINDOW_MS },
  passwordReset: { limit: 5, windowMs: 15 * 60_000 },
  platformOrder: { limit: 1000, windowMs: RATE_LIMIT_WINDOW_MS },
  quickPaste: { limit: 50, windowMs: RATE_LIMIT_WINDOW_MS },
  adminWrites: { limit: 500, windowMs: RATE_LIMIT_WINDOW_MS },
  courierStatus: { limit: 100, windowMs: RATE_LIMIT_WINDOW_MS },
  general: { limit: 1000, windowMs: RATE_LIMIT_WINDOW_MS },
};
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const COURIER_PUSH_EVENT_TYPES = new Set(["package-assigned", "package-override", "package-reassign"]);
const RESTAURANT_PUSH_EVENT_TYPES = new Set(["package-created", "platform-order-pending", "integration-order", "order:new", "restaurant-push-test"]);
const WEB_PUSH_DEDUPE_MS = 90 * 1000;
const recentWebPushes = new Map();
const WEB_PUSH_SETTINGS_ID = "courier_web_push_vapid";
const WEB_PUSH_SUBJECT = trimmed(process.env.DELIVERA_VAPID_SUBJECT) || "mailto:bildirim@paketdelivera.app";

const DEFAULT_ZONES = ["Akdeniz", "Yenisehir", "Mezitli", "Toroslar", "Tarsus", "Erdemli"];
const SUPPORTED_PLATFORMS = ["Trendyol Yemek", "Yemeksepeti", "Getir Yemek", "Migros Yemek", "POS"];
const PLATFORM_SLUGS = {
  "Trendyol Yemek": "trendyol-yemek",
  Yemeksepeti: "yemeksepeti",
  "Getir Yemek": "getir-yemek",
  "Migros Yemek": "migros-yemek",
  POS: "pos",
};
const PLATFORM_ALIASES = {
  "trendyol go": "Trendyol Yemek",
  "trendyol yemek": "Trendyol Yemek",
  trendyol: "Trendyol Yemek",
  "getiryemek": "Getir Yemek",
  "getir yemek": "Getir Yemek",
  getir: "Getir Yemek",
  "yemek sepeti": "Yemeksepeti",
  "migrosyemek": "Migros Yemek",
  "migros yemek": "Migros Yemek",
  migros: "Migros Yemek",
};
const PLATFORM_WEBHOOK_AUTH_TYPES = {
  API_KEY: "api_key",
  BASIC_AUTH: "basic_auth",
  STATIC_TOKEN: "static_token",
};
const PLATFORM_VERIFICATION_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  FAILED: "failed",
};
const PLATFORM_CONFIGS = {
  "Trendyol Yemek": {
    platform: "Trendyol Yemek",
    mode: "polling",
    requiredFields: ["externalStoreId", "apiKey", "apiSecret"],
    optionalFields: ["token", "webhookSecret"],
    testStrategy: "polling",
    userFriendlyErrors: {
      missingCredentials: "Supplier ID, API Key ve API Secret girilmeli.",
    },
  },
  "Getir Yemek": {
    platform: "Getir Yemek",
    mode: "webhook",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiSecret"],
    testStrategy: "local_webhook",
    userFriendlyErrors: {
      missingCredentials: "Store/Restaurant ID ve Webhook Secret girilmeli.",
    },
  },
  Yemeksepeti: {
    platform: "Yemeksepeti",
    mode: "hybrid",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiKey", "apiSecret", "token"],
    testStrategy: "auto",
    userFriendlyErrors: {
      missingCredentials: "Vendor ID ve Webhook Secret girilmeli.",
    },
  },
  "Migros Yemek": {
    platform: "Migros Yemek",
    mode: "webhook",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiKey", "apiSecret", "token"],
    testStrategy: "local_webhook",
    userFriendlyErrors: {
      missingCredentials: "Restoran ID ve Webhook Secret girilmeli.",
    },
  },
};
const ASSIGNMENT_RETRY_INTERVAL_MS = Number(process.env.DELIVERA_ASSIGNMENT_RETRY_MS || 15_000);
const COURIER_OFFER_TIMEOUT_MS = Number(process.env.DELIVERA_COURIER_OFFER_TIMEOUT_MS || 45_000);
const COURIER_REJECTION_COOLDOWN_MS = Number(process.env.DELIVERA_COURIER_REJECTION_COOLDOWN_MS || 30_000);
const PACKAGE_REJECTION_COOLDOWN_MS = Number(process.env.DELIVERA_PACKAGE_REJECTION_COOLDOWN_MS || 5_000);
const COURIER_LOCATION_FRESHNESS_MS = Number(process.env.DELIVERA_COURIER_LOCATION_FRESHNESS_MS || 30 * 60_000);
const COURIER_BACKGROUND_LOCATION_MAX_AGE_MS = Number(process.env.DELIVERA_COURIER_BACKGROUND_LOCATION_MAX_AGE_MS || 12 * 60 * 60_000);
const COURIER_LIVE_LOCATION_FRESHNESS_MS = Number(process.env.DELIVERA_COURIER_LIVE_LOCATION_FRESHNESS_MS || 2 * 60_000);
const PENDING_APPROVAL_STATUS = "pending_approval";
const PENDING_STATUS = "pending";
const PREPARING_STATUS = "preparing";
const AWAITING_ASSIGNMENT_STATUS = "awaiting_assignment";
const ASSIGNED_STATUS = "assigned";
const ACCEPTED_BY_COURIER_STATUS = "accepted_by_courier";
const ON_ROUTE_STATUS = "on_route";
const DELIVERED_STATUS = "delivered";
const FAILED_STATUS = "failed";
const REJECTED_STATUS = "rejected";
const CANCELED_STATUS = "cancelled";
const UNPAID_PAYMENT_STATUS = "unpaid";
const PAID_ONLINE_PAYMENT_STATUS = "paid_online";
const CASH_EXPECTED_PAYMENT_STATUS = "cash_expected";
const CASH_COLLECTED_PAYMENT_STATUS = "cash_collected";
const PAYMENT_ISSUE_STATUS = "payment_issue";
const CREDIT_CARD_PAYMENT_STATUS = "credit_card";
const CREDIT_CARD_COLLECTED_PAYMENT_STATUS = "credit_card_collected";
const RESTAURANT_COLLECTED_PAYMENT_STATUS = "restaurant_collected";
const COLLECTED_PAYMENT_STATUS = "collected";
const VALID_PAYMENT_METHODS = new Set([
  "cash_on_delivery",
  "card_on_delivery",
  "paid_online",
  "collected",
  "restaurant_collected",
  "payment_issue",
]);
const VALID_PAYMENT_STATUSES = new Set([
  UNPAID_PAYMENT_STATUS,
  PAID_ONLINE_PAYMENT_STATUS,
  CASH_EXPECTED_PAYMENT_STATUS,
  CASH_COLLECTED_PAYMENT_STATUS,
  PAYMENT_ISSUE_STATUS,
  CREDIT_CARD_PAYMENT_STATUS,
  CREDIT_CARD_COLLECTED_PAYMENT_STATUS,
  RESTAURANT_COLLECTED_PAYMENT_STATUS,
  COLLECTED_PAYMENT_STATUS,
]);
const PAYMENT_METHOD_LABELS = {
  cash_on_delivery: "Nakit tahsil edilecek",
  card_on_delivery: "Kredi karti tahsil edilecek",
  paid_online: "Online odendi",
  collected: "Tahsil edildi",
  restaurant_collected: "Restoran tahsil etti",
  payment_issue: "Tahsil edilemedi",
};
const COURIER_OFFLINE_STATUS = "offline";
const COURIER_ONLINE_STATUS = "online";
const COURIER_BUSY_STATUS = "busy";
const ADMIN_MANUAL_MAX_ACTIVE_PACKAGES = 4;
const AUTO_SAME_RESTAURANT_MAX_ACTIVE_PACKAGES = 2;
const COURIER_POOL_MAX_ACTIVE_PACKAGES = 2;
const AUTOMATIC_ASSIGNMENT_MAX_PACKAGE_AGE_MS = 24 * 60 * 60 * 1000;
const COURIER_FAILURE_REASONS = new Set([
  "musteri_yok",
  "adres_bulunamadi",
  "restoran_hazir_degil",
  "teknik_sorun",
  "ters_yon",
  "diger",
]);
const ASSIGNMENT_SEARCH_RADII_KM = Object.freeze([5, 6, 7, 8]);
const MAX_ASSIGNMENT_DISTANCE_KM = ASSIGNMENT_SEARCH_RADII_KM.at(-1);
const ASSIGNMENT_FAIRNESS_DISTANCE_TOLERANCE_KM = 1;
const LIVE_STREAM_HEARTBEAT_MS = 20_000;
const STATUS_TRANSITIONS = {
  [PENDING_APPROVAL_STATUS]: [PREPARING_STATUS, REJECTED_STATUS, CANCELED_STATUS],
  [PENDING_STATUS]: [AWAITING_ASSIGNMENT_STATUS, CANCELED_STATUS],
  [PREPARING_STATUS]: [ASSIGNED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [AWAITING_ASSIGNMENT_STATUS]: [ASSIGNED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ASSIGNED_STATUS]: [AWAITING_ASSIGNMENT_STATUS, ACCEPTED_BY_COURIER_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ACCEPTED_BY_COURIER_STATUS]: [ON_ROUTE_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ON_ROUTE_STATUS]: [DELIVERED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [DELIVERED_STATUS]: [],
  [FAILED_STATUS]: [AWAITING_ASSIGNMENT_STATUS, CANCELED_STATUS],
  [REJECTED_STATUS]: [],
  [CANCELED_STATUS]: [],
};
const KNOWN_PACKAGE_STATUSES = new Set(Object.keys(STATUS_TRANSITIONS));
const PLATFORM_POLL_INTERVAL_MS = Number(process.env.DELIVERA_PLATFORM_POLLING_INTERVAL_MS || process.env.DELIVERA_PLATFORM_POLL_INTERVAL_MS || 30_000);
const PLATFORM_POLLING_ENABLED = ["1", "true", "yes"].includes(String(process.env.DELIVERA_PLATFORM_POLLING_ENABLED || "").toLowerCase());
const POSENTEGRA_INBOUND_SYNC_INTERVAL_MS = Math.max(5_000, Number(process.env.POSENTEGRA_INBOUND_SYNC_INTERVAL_MS || 30_000));
const ASSIGNMENT_DEBUG_LOGS = ["1", "true", "yes"].includes(String(process.env.DELIVERA_ASSIGNMENT_DEBUG || "").toLowerCase());
const PLATFORM_ORDER_STATUSES = new Set(["pending_approval", "approved", "assigned", "completed", "cancelled"]);
const COURIER_ALLOWED_STATUSES = new Set([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, FAILED_STATUS]);
const LEGACY_STATUS_MAP = {
  "Kurye Bekleniyor": AWAITING_ASSIGNMENT_STATUS,
  "Kurye Atandi": ASSIGNED_STATUS,
  "Kurye Yolda": ON_ROUTE_STATUS,
  "Teslim Edildi": DELIVERED_STATUS,
  "Teslim Edilemedi": FAILED_STATUS,
  "Iptal Edildi": CANCELED_STATUS,
  pending_approval: PENDING_APPROVAL_STATUS,
  waiting: AWAITING_ASSIGNMENT_STATUS,
  waiting_assignment: AWAITING_ASSIGNMENT_STATUS,
  pending: PENDING_STATUS,
  preparing: PREPARING_STATUS,
  awaiting_assignment: AWAITING_ASSIGNMENT_STATUS,
  assigned: ASSIGNED_STATUS,
  accepted_by_courier: ACCEPTED_BY_COURIER_STATUS,
  picked_up: ON_ROUTE_STATUS,
  on_the_way: ON_ROUTE_STATUS,
  on_route: ON_ROUTE_STATUS,
  delivered: DELIVERED_STATUS,
  failed: FAILED_STATUS,
  rejected: REJECTED_STATUS,
  cancelled: CANCELED_STATUS,
};

const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/landing-final.css": "landing-final.css",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/privacy.html": "privacy.html",
  "/shared.js": "shared.js",
  "/system-curtain.js": "system-curtain.js",
  "/system-curtain-control.js": "system-curtain-control.js",
  "/system-curtain-control.css": "system-curtain-control.css",
  "/login-shell.js": "login-shell.js",
  "/assets/delivera-login.jpg": "assets/delivera-login.jpg",
  "/restaurant.html": "restaurant-design-source/code.html",
  "/admin.html": "admin-design-source/code.html",
  "/admin-local.css": "admin-design-source/admin-local.css",
  "/courier.html": "courier.html",
  "/courier-shift.html": "courier-design-source/vardiya_y_netimi/code.html",
  "/courier-reports.html": "courier-design-source/performans_raporlar/code.html",
  "/courier-profile.html": "courier-design-source/profil_ve_ayarlar/code.html",
  "/courier-design-bridge.js": "courier-design-bridge.js",
  "/restaurant-design-bridge.js": "restaurant-design-bridge.js",
  "/admin-design-bridge.js": "admin-design-bridge.js",
  "/downloads/restomap-restoran-kurulum.cmd": "restomap-restoran-kurulum.cmd",
  "/downloads/delivera-restoran-kurulum.cmd": "delivera-restoran-kurulum.cmd",
  "/vendor/leaflet.js": "node_modules/leaflet/dist/leaflet.js",
  "/vendor/leaflet.css": "node_modules/leaflet/dist/leaflet.css",
  "/landing.js": "landing.js",
  "/restaurant.js": "restaurant.js",
  "/admin.js": "admin.js",
  "/courier.js": "courier.js",
};

fs.mkdirSync(LOG_DIR, { recursive: true });

logger.info("Database environment detected", dbFacade.databaseEnvInfo());
let migrationSummary;
try {
  migrationSummary = runMigrations();
} catch (error) {
  logger.error("Database initialization failed", {
    error,
    databaseEnv: dbFacade.databaseEnvInfo(),
  });
  throw error;
}
logger.info("Database migrations checked", {
  database: migrationSummary.database,
  adapter: migrationSummary.adapter,
  applied: migrationSummary.applied?.length || 0,
  skipped: migrationSummary.skipped?.length || 0,
  appliedMigrations: migrationSummary.applied || [],
  skippedMigrations: migrationSummary.skipped || [],
});

const db = getDb({ filename: DB_FILE });
const poolStatus = dbFacade.poolStatus();
logger.info("Database pool status", {
  database: migrationSummary.database,
  pool: poolStatus,
});
const rateLimitStore = createRateLimitStore({ redisUrl: REDIS_URL, logger, db, dbClient: dbFacade.clientName() });
const queueService = createQueueService({ redisUrl: REDIS_URL, logger });
const posentegraOutbox = createPosentegraOutboxService({ db, client: posentegraClient, logger });
const sessionRevocationService = createSessionRevocationService({ redisUrl: REDIS_URL, logger, db, dbClient: dbFacade.clientName() });
const liveStreams = new Map();
const performanceMetrics = {
  startedAt: Date.now(),
  requestCount: 0,
  totalResponseTimeMs: 0,
  maxResponseTimeMs: 0,
  errorCount: 0,
  statusBuckets: {},
  recentResponseTimes: [],
};
const recentRequestLogs = [];
let assignmentSweepRunning = false;
let assignmentSweepQueued = false;
const assignmentRetryTimers = new Map();
let platformService = null;
let connectionHealthService = null;
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS zones (
    name TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    posentegra_id TEXT,
    username TEXT UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    platforms_json TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    webhook_secret TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS couriers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    available INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    last_location_at TEXT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY,
    tracking_no TEXT NOT NULL UNIQUE,
    restaurant_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'restaurant_panel',
    delivery_address TEXT,
    package_type TEXT,
    source_platform TEXT NOT NULL,
    platform_restaurant_id TEXT,
    posentegra_id TEXT,
    external_order_no TEXT NOT NULL,
    external_order_id TEXT,
    recipient TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    zone TEXT NOT NULL,
    eta TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    order_amount REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    x REAL NOT NULL,
    y REAL NOT NULL,
    customer_lat REAL,
    customer_lng REAL,
    customer_address TEXT,
    note TEXT NOT NULL,
    status TEXT NOT NULL,
    assignment_status TEXT,
    assigned_courier_id TEXT,
    assigned_courier_name TEXT,
    assigned_at TEXT,
    accepted_at TEXT,
    on_route_at TEXT,
    delivered_at TEXT,
    failed_at TEXT,
    distance_km REAL,
    assignment_reason TEXT NOT NULL,
    failure_reason TEXT,
    last_assignment_attempt_at TEXT,
    last_assignment_error TEXT,
    assignment_tried_courier_ids_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(restaurant_id, phone),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS courier_sessions (
    token TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS restaurant_sessions (
    token TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    actor_role TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    actor_role TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    requested_ip TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id TEXT,
    source_platform TEXT,
    external_order_no TEXT,
    signature_valid INTEGER NOT NULL,
    response_status INTEGER NOT NULL,
    request_body TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    dead_lettered_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_role TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    package_id TEXT,
    restaurant_id TEXT,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_events (
    id TEXT PRIMARY KEY,
    platform_account_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS restaurant_panel_data (
    restaurant_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    external_id TEXT,
    external_store_id TEXT NOT NULL,
    external_merchant_id TEXT,
    api_username TEXT,
    api_password TEXT,
    api_key TEXT,
    api_secret TEXT,
    token TEXT,
    store_front_code TEXT,
    chain_id TEXT,
    vendor_id TEXT,
    webhook_auth_type TEXT NOT NULL,
    webhook_api_key TEXT,
    webhook_username TEXT,
    webhook_password TEXT,
    static_token TEXT,
    webhook_secret TEXT,
    integration_reference_code TEXT,
    pos_secret_key TEXT,
    is_active INTEGER,
        last_sync_at TEXT,
        connection_status TEXT NOT NULL DEFAULT 'unknown',
        last_check_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_http_status INTEGER,
        last_latency_ms INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_callback_at TEXT,
        webhook_id TEXT,
    settings_json TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    verification_note TEXT,
    last_verification_at TEXT,
    verified_at TEXT,
    last_validation_mode TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS platform_orders (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_order_id TEXT NOT NULL,
    platform_restaurant_id TEXT,
    posentegra_id TEXT,
    restaurant_id TEXT NOT NULL,
    package_id TEXT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    total_price REAL NOT NULL DEFAULT 0,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    raw_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(platform, platform_order_id, restaurant_id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
    FOREIGN KEY (package_id) REFERENCES packages(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    external_product_id TEXT,
    product_id TEXT,
    name TEXT,
    quantity REAL NOT NULL DEFAULT 1,
    price REAL NOT NULL DEFAULT 0,
    option_price REAL NOT NULL DEFAULT 0,
    price_with_option REAL NOT NULL DEFAULT 0,
    total_price REAL NOT NULL DEFAULT 0,
    total_option_price REAL NOT NULL DEFAULT 0,
    total_price_with_option REAL NOT NULL DEFAULT 0,
    note TEXT,
    removed_ingredients TEXT,
    extra_ingredients TEXT,
    raw_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES packages(id)
  );

  CREATE TABLE IF NOT EXISTS unmatched_orders (
    id TEXT PRIMARY KEY,
    external_order_id TEXT,
    confirmation_id TEXT,
    external_restaurant_id TEXT,
    restaurant_name_from_payload TEXT,
    platform TEXT,
    platform_slug TEXT,
    provider_name TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    total_price REAL NOT NULL DEFAULT 0,
    status TEXT,
    raw_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_resolved INTEGER NOT NULL DEFAULT 0,
    resolved_restaurant_id TEXT,
    resolved_package_id TEXT,
    resolved_at TEXT,
    FOREIGN KEY (resolved_restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS courier_daily_reports (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    courier_name TEXT NOT NULL,
    zone TEXT NOT NULL,
    report_date TEXT NOT NULL,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    paid_online_amount REAL NOT NULL DEFAULT 0,
    cash_collected_amount REAL NOT NULL DEFAULT 0,
    credit_card_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    package_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courier_earnings (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    delivered_package_count INTEGER NOT NULL DEFAULT 0,
    per_package_fee REAL NOT NULL DEFAULT 0,
    bonus_amount REAL NOT NULL DEFAULT 0,
    deduction_amount REAL NOT NULL DEFAULT 0,
    total_payable REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    paid_at TEXT,
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(courier_id, report_date),
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS courier_earning_items (
    id TEXT PRIMARY KEY,
    courier_earning_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    package_fee REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(courier_earning_id, package_id),
    FOREIGN KEY (courier_earning_id) REFERENCES courier_earnings(id),
    FOREIGN KEY (package_id) REFERENCES packages(id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS restaurant_settlements (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    total_packages INTEGER NOT NULL DEFAULT 0,
    total_cash REAL NOT NULL DEFAULT 0,
    total_card REAL NOT NULL DEFAULT 0,
    total_online REAL NOT NULL DEFAULT 0,
    total_restaurant_collected REAL NOT NULL DEFAULT 0,
    total_courier_collected REAL NOT NULL DEFAULT 0,
    service_fee REAL NOT NULL DEFAULT 0,
    net_payable REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unpaid',
    paid_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(restaurant_id, start_date, end_date),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS courier_shifts (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS courier_breaks (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS notification_logs (
    id TEXT PRIMARY KEY,
    target_role TEXT NOT NULL,
    target_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courier_shift_plans (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    zone TEXT NOT NULL,
    plan_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS cash_reconciliations (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    expected_cash REAL NOT NULL DEFAULT 0,
    reported_cash REAL NOT NULL DEFAULT 0,
    variance REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    package_ids_json TEXT NOT NULL,
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    target_role TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS management_records (
    id TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,
    subject_type TEXT NOT NULL DEFAULT '',
    subject_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_management_records_type_subject
  ON management_records (record_type, subject_id, status, start_date);
`);

const courierColumns = db.prepare("PRAGMA table_info(couriers)").all().map((row) => row.name);
if (!courierColumns.includes("last_location_at")) {
  db.exec("ALTER TABLE couriers ADD COLUMN last_location_at TEXT");
}
if (!courierColumns.includes("status")) {
  db.exec(`ALTER TABLE couriers ADD COLUMN status TEXT NOT NULL DEFAULT '${COURIER_OFFLINE_STATUS}'`);
}
if (!courierColumns.includes("per_package_fee")) {
  db.exec("ALTER TABLE couriers ADD COLUMN per_package_fee REAL");
}

const packageColumns = db.prepare("PRAGMA table_info(packages)").all().map((row) => row.name);
if (!packageColumns.includes("delivery_address")) {
  db.exec("ALTER TABLE packages ADD COLUMN delivery_address TEXT");
}
if (!packageColumns.includes("package_type")) {
  db.exec("ALTER TABLE packages ADD COLUMN package_type TEXT");
}
if (!packageColumns.includes("source")) {
  db.exec("ALTER TABLE packages ADD COLUMN source TEXT NOT NULL DEFAULT 'restaurant_panel'");
}
if (!packageColumns.includes("external_order_id")) {
  db.exec("ALTER TABLE packages ADD COLUMN external_order_id TEXT");
}
if (!packageColumns.includes("payment_status")) {
  db.exec(`ALTER TABLE packages ADD COLUMN payment_status TEXT NOT NULL DEFAULT '${UNPAID_PAYMENT_STATUS}'`);
}
if (!packageColumns.includes("order_amount")) {
  db.exec("ALTER TABLE packages ADD COLUMN order_amount REAL NOT NULL DEFAULT 0");
}
if (!packageColumns.includes("assignment_status")) {
  db.exec("ALTER TABLE packages ADD COLUMN assignment_status TEXT");
}
if (!packageColumns.includes("assigned_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN assigned_at TEXT");
}
if (!packageColumns.includes("accepted_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN accepted_at TEXT");
}
if (!packageColumns.includes("on_route_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN on_route_at TEXT");
}
if (!packageColumns.includes("delivered_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN delivered_at TEXT");
}
if (!packageColumns.includes("failed_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN failed_at TEXT");
}
if (!packageColumns.includes("failure_reason")) {
  db.exec("ALTER TABLE packages ADD COLUMN failure_reason TEXT");
}
if (!packageColumns.includes("last_assignment_attempt_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN last_assignment_attempt_at TEXT");
}
if (!packageColumns.includes("last_assignment_error")) {
  db.exec("ALTER TABLE packages ADD COLUMN last_assignment_error TEXT");
}
if (!packageColumns.includes("updated_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN updated_at TEXT");
}
if (!packageColumns.includes("customer_note")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_note TEXT");
}
if (!packageColumns.includes("items_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN items_json TEXT");
}
if (!packageColumns.includes("raw_payload_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN raw_payload_json TEXT");
}
if (!packageColumns.includes("customer_lat")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_lat REAL");
}
if (!packageColumns.includes("customer_lng")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_lng REAL");
}
if (!packageColumns.includes("customer_address")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_address TEXT");
}
if (!packageColumns.includes("platform_status_logs_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN platform_status_logs_json TEXT");
}
if (!packageColumns.includes("assignment_tried_courier_ids_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN assignment_tried_courier_ids_json TEXT");
}
[
  ["payment_collected_by", "TEXT"],
  ["collected_amount", "REAL NOT NULL DEFAULT 0"],
  ["courier_collection_note", "TEXT"],
  ["restaurant_customer_id", "TEXT"],
  ["customer_id", "TEXT"],
  ["confirmation_id", "TEXT"],
  ["platform_restaurant_id", "TEXT"],
  ["posentegra_id", "TEXT"],
  ["external_restaurant_id", "TEXT"],
  ["restaurant_name_from_payload", "TEXT"],
  ["platform_slug", "TEXT"],
  ["provider_id", "TEXT"],
  ["provider_name", "TEXT"],
  ["contact_phone", "TEXT"],
  ["city", "TEXT"],
  ["district", "TEXT"],
  ["street", "TEXT"],
  ["building_no", "TEXT"],
  ["floor", "TEXT"],
  ["door_no", "TEXT"],
  ["address_description", "TEXT"],
  ["status_text", "TEXT"],
  ["raw_status", "TEXT"],
  ["discounted_price", "REAL"],
  ["total_discount", "REAL"],
  ["pos_payment_method", "TEXT"],
  ["pos_ticket", "TEXT"],
  ["short_code", "TEXT"],
  ["delivery_type", "TEXT"],
  ["is_scheduled", "INTEGER NOT NULL DEFAULT 0"],
  ["scheduled_date", "TEXT"],
].forEach(([columnName, definition]) => {
  if (!packageColumns.includes(columnName)) {
    db.exec(`ALTER TABLE packages ADD COLUMN ${columnName} ${definition}`);
  }
});

const customerColumns = db.prepare("PRAGMA table_info(customers)").all().map((row) => row.name);
if (customerColumns.length > 0 && !customerColumns.includes("updated_at")) {
  db.exec("ALTER TABLE customers ADD COLUMN updated_at TEXT");
}
[
  ["note", "TEXT"],
  ["order_count", "INTEGER NOT NULL DEFAULT 0"],
  ["last_order_at", "TEXT"],
  ["is_active", "INTEGER NOT NULL DEFAULT 1"],
].forEach(([columnName, definition]) => {
  if (customerColumns.length > 0 && !customerColumns.includes(columnName)) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${columnName} ${definition}`);
  }
});

const webhookLogColumns = db.prepare("PRAGMA table_info(webhook_logs)").all().map((row) => row.name);
if (!webhookLogColumns.includes("retry_count")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
}
if (!webhookLogColumns.includes("next_retry_at")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN next_retry_at TEXT");
}
if (!webhookLogColumns.includes("dead_lettered_at")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN dead_lettered_at TEXT");
}
if (!webhookLogColumns.includes("last_error")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN last_error TEXT");
}

const shiftPlanColumns = db.prepare("PRAGMA table_info(courier_shift_plans)").all().map((row) => row.name);
if (!shiftPlanColumns.includes("offer_expires_at")) {
  db.exec("ALTER TABLE courier_shift_plans ADD COLUMN offer_expires_at TEXT");
}
if (!shiftPlanColumns.includes("accepted_at")) {
  db.exec("ALTER TABLE courier_shift_plans ADD COLUMN accepted_at TEXT");
}
if (!shiftPlanColumns.includes("notified_at")) {
  db.exec("ALTER TABLE courier_shift_plans ADD COLUMN notified_at TEXT");
}

db.prepare(`
  UPDATE packages
  SET source = 'external_manual',
      source_platform = CASE
        WHEN TRIM(COALESCE(source_platform, '')) = '' THEN 'Dis Manuel Paket'
        ELSE source_platform
      END
  WHERE source = 'restaurant_panel'
`).run();

const courierReportColumns = db.prepare("PRAGMA table_info(courier_daily_reports)").all().map((column) => column.name);
if (courierReportColumns.length > 0) {
  if (!courierReportColumns.includes('status')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_approval'");
  }
  if (!courierReportColumns.includes('credit_card_amount')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN credit_card_amount REAL NOT NULL DEFAULT 0");
  }
  if (!courierReportColumns.includes('collected_total')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN collected_total REAL NOT NULL DEFAULT 0");
  }
  if (!courierReportColumns.includes('failed_collection_total')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN failed_collection_total REAL NOT NULL DEFAULT 0");
  }
  if (!courierReportColumns.includes('restaurant_collected_amount')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN restaurant_collected_amount REAL NOT NULL DEFAULT 0");
  }
  if (!courierReportColumns.includes('courier_note')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN courier_note TEXT");
  }
  if (!courierReportColumns.includes('admin_note')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN admin_note TEXT");
  }
  if (!courierReportColumns.includes('approved_at')) {
    db.exec("ALTER TABLE courier_daily_reports ADD COLUMN approved_at TEXT");
  }
}

const dummy_variable_to_preserve_structure = true;

if (courierReportColumns.length === 0) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_daily_reports (
      id TEXT PRIMARY KEY,
      courier_id TEXT NOT NULL,
      courier_name TEXT NOT NULL,
      zone TEXT NOT NULL,
      report_date TEXT NOT NULL,
      delivered_count INTEGER NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_online_amount REAL NOT NULL DEFAULT 0,
      cash_collected_amount REAL NOT NULL DEFAULT 0,
      package_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

const courierShiftColumns = db.prepare("PRAGMA table_info(courier_shifts)").all().map((column) => column.name);
if (courierShiftColumns.length === 0) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_shifts (
      id TEXT PRIMARY KEY,
      courier_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (courier_id) REFERENCES couriers(id)
    )
  `);
}

const restaurantColumns = db.prepare("PRAGMA table_info(restaurants)").all().map((row) => row.name);
if (!restaurantColumns.includes("username")) {
  db.exec("ALTER TABLE restaurants ADD COLUMN username TEXT");
}
if (!restaurantColumns.includes("password_hash")) {
  db.exec("ALTER TABLE restaurants ADD COLUMN password_hash TEXT");
}
if (!restaurantColumns.includes("password_salt")) {
  db.exec("ALTER TABLE restaurants ADD COLUMN password_salt TEXT");
}
[
  ["trendyol_restaurant_id", "TEXT"],
  ["yemeksepeti_restaurant_id", "TEXT"],
  ["getir_restaurant_id", "TEXT"],
  ["migros_restaurant_id", "TEXT"],
  ["posentegra_id", "TEXT"],
  ["external_restaurant_ids", "TEXT"],
].forEach(([columnName, definition]) => {
  if (!restaurantColumns.includes(columnName)) {
    db.exec(`ALTER TABLE restaurants ADD COLUMN ${columnName} ${definition}`);
  }
});

const platformOrderColumns = db.prepare("PRAGMA table_info(platform_orders)").all().map((row) => row.name);
[
  ["platform_restaurant_id", "TEXT"],
  ["posentegra_id", "TEXT"],
  ["package_id", "TEXT"],
].forEach(([columnName, definition]) => {
  if (!platformOrderColumns.includes(columnName)) {
    db.exec(`ALTER TABLE platform_orders ADD COLUMN ${columnName} ${definition}`);
  }
});

const webhookLogColumnsAfterApiExpansion = db.prepare("PRAGMA table_info(webhook_logs)").all().map((row) => row.name);
[
  ["request_id", "TEXT"],
  ["provider", "TEXT"],
  ["platform", "TEXT"],
  ["external_restaurant_id", "TEXT"],
  ["external_order_id", "TEXT"],
  ["is_matched", "INTEGER"],
  ["status", "TEXT"],
  ["http_status", "INTEGER"],
  ["error_message", "TEXT"],
  ["raw_payload", "TEXT"],
  ["headers", "TEXT"],
  ["ip_address", "TEXT"],
].forEach(([columnName, definition]) => {
  if (!webhookLogColumnsAfterApiExpansion.includes(columnName)) {
    db.exec(`ALTER TABLE webhook_logs ADD COLUMN ${columnName} ${definition}`);
  }
});

const platformAccountColumns = db.prepare("PRAGMA table_info(platform_accounts)").all().map((row) => row.name);
if (!platformAccountColumns.includes("external_id")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN external_id TEXT");
}
if (!platformAccountColumns.includes("verification_status")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'");
}
if (!platformAccountColumns.includes("verification_note")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN verification_note TEXT");
}
if (!platformAccountColumns.includes("last_verification_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_verification_at TEXT");
}
if (!platformAccountColumns.includes("verified_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN verified_at TEXT");
}
if (!platformAccountColumns.includes("last_validation_mode")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_validation_mode TEXT");
}
if (!platformAccountColumns.includes("access_token")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN access_token TEXT");
}
if (!platformAccountColumns.includes("refresh_token")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN refresh_token TEXT");
}
if (!platformAccountColumns.includes("token_expires_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN token_expires_at TEXT");
}
if (!platformAccountColumns.includes("callback_url")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN callback_url TEXT");
}
if (!platformAccountColumns.includes("auth_type")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN auth_type TEXT");
}
if (!platformAccountColumns.includes("webhook_secret")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN webhook_secret TEXT");
}
if (!platformAccountColumns.includes("token")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN token TEXT");
}
if (!platformAccountColumns.includes("integration_reference_code")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN integration_reference_code TEXT");
}
if (!platformAccountColumns.includes("pos_secret_key")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN pos_secret_key TEXT");
}
if (!platformAccountColumns.includes("is_active")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN is_active INTEGER");
}
if (!platformAccountColumns.includes("last_sync_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_sync_at TEXT");
}
if (!platformAccountColumns.includes("integration_ref_code")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN integration_ref_code TEXT");
}
if (!platformAccountColumns.includes("polling_enabled")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN polling_enabled INTEGER NOT NULL DEFAULT 0");
}
if (!platformAccountColumns.includes("webhook_enabled")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 1");
}
if (!platformAccountColumns.includes("last_webhook_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_webhook_at TEXT");
}
if (!platformAccountColumns.includes("last_poll_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_poll_at TEXT");
}
if (!platformAccountColumns.includes("last_error")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_error TEXT");
}
[
  ["connection_status", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["last_check_at", "TEXT"],
  ["last_success_at", "TEXT"],
  ["last_error_at", "TEXT"],
  ["last_error_code", "TEXT"],
  ["last_error_message", "TEXT"],
  ["last_http_status", "INTEGER"],
  ["last_latency_ms", "INTEGER"],
  ["consecutive_failures", "INTEGER NOT NULL DEFAULT 0"],
  ["last_callback_at", "TEXT"],
].forEach(([columnName, definition]) => {
  if (!platformAccountColumns.includes(columnName)) {
    db.exec(`ALTER TABLE platform_accounts ADD COLUMN ${columnName} ${definition}`);
  }
});

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_orders_unique
  ON platform_orders (platform, platform_order_id, restaurant_id);

  CREATE INDEX IF NOT EXISTS idx_packages_restaurant_created
  ON packages (restaurant_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_packages_status_created
  ON packages (status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_packages_zone_status
  ON packages (zone, status);

  CREATE INDEX IF NOT EXISTS idx_packages_assigned_status
  ON packages (assigned_courier_id, status, assigned_at);

  CREATE INDEX IF NOT EXISTS idx_packages_duplicate_lookup
  ON packages (restaurant_id, source, external_order_id);

  CREATE INDEX IF NOT EXISTS idx_packages_platform_lookup
  ON packages (restaurant_id, source_platform, external_order_id);

  CREATE INDEX IF NOT EXISTS idx_couriers_status_zone
  ON couriers (status, zone);

  CREATE INDEX IF NOT EXISTS idx_couriers_zone_status
  ON couriers (zone, status);

  CREATE INDEX IF NOT EXISTS idx_platform_accounts_lookup
  ON platform_accounts (platform, external_store_id, active, webhook_enabled);

  CREATE INDEX IF NOT EXISTS idx_platform_accounts_restaurant_updated
  ON platform_accounts (restaurant_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_orders_restaurant_status_created
  ON platform_orders (restaurant_id, status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_audit_logs_restaurant_id_desc
  ON audit_logs (restaurant_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_webhook_logs_restaurant_id_desc
  ON webhook_logs (restaurant_id, id DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_trendyol_external
  ON restaurants (trendyol_restaurant_id)
  WHERE trendyol_restaurant_id IS NOT NULL AND trendyol_restaurant_id != '';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_yemeksepeti_external
  ON restaurants (yemeksepeti_restaurant_id)
  WHERE yemeksepeti_restaurant_id IS NOT NULL AND yemeksepeti_restaurant_id != '';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_getir_external
  ON restaurants (getir_restaurant_id)
  WHERE getir_restaurant_id IS NOT NULL AND getir_restaurant_id != '';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_migros_external
  ON restaurants (migros_restaurant_id)
  WHERE migros_restaurant_id IS NOT NULL AND migros_restaurant_id != '';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_posentegra_external
  ON restaurants (posentegra_id)
  WHERE posentegra_id IS NOT NULL AND posentegra_id != '';

  CREATE INDEX IF NOT EXISTS idx_order_items_order_id
  ON order_items (order_id);

  CREATE INDEX IF NOT EXISTS idx_unmatched_orders_created
  ON unmatched_orders (is_resolved, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_packages_api_order_lookup
  ON packages (external_order_id, confirmation_id, restaurant_id);

  CREATE INDEX IF NOT EXISTS idx_packages_posentegra_id
  ON packages (posentegra_id)
  WHERE posentegra_id IS NOT NULL AND posentegra_id != '';

  CREATE INDEX IF NOT EXISTS idx_packages_platform_restaurant_id
  ON packages (platform_restaurant_id)
  WHERE platform_restaurant_id IS NOT NULL AND platform_restaurant_id != '';

  CREATE INDEX IF NOT EXISTS idx_platform_orders_posentegra_id
  ON platform_orders (posentegra_id)
  WHERE posentegra_id IS NOT NULL AND posentegra_id != '';

  CREATE TABLE IF NOT EXISTS platform_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT,
    restaurant_id TEXT,
    platform_account_id TEXT,
    event_type TEXT NOT NULL,
    request_id TEXT,
    status TEXT NOT NULL,
    http_status INTEGER,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    dead_lettered_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_platform_events_account_created
  ON platform_events (platform_account_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_events_restaurant_created
  ON platform_events (restaurant_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_events_type_status_created
  ON platform_events (event_type, status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_accounts_connection_status
  ON platform_accounts (connection_status, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_notification_logs_target_created
  ON notification_logs (target_role, target_id, created_at DESC);
`);

const zoneInsert = db.prepare("INSERT OR IGNORE INTO zones (name) VALUES (?)");
DEFAULT_ZONES.forEach((zone) => zoneInsert.run(zone));

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function trackingNoExists(trackingNo) {
  return Boolean(db.prepare("SELECT 1 FROM packages WHERE tracking_no = ?").get(trackingNo));
}

function generateTrackingNo() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `PKT-${Math.floor(100000 + Math.random() * 900000)}`;
    if (!trackingNoExists(candidate)) {
      return candidate;
    }
  }
  return `PKT-${Date.now()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function ensureUniqueTrackingNo(preferred) {
  const incoming = trimmed(preferred);
  if (incoming && !trackingNoExists(incoming)) {
    return incoming;
  }
  return generateTrackingNo();
}

function resolvePackagePosentegraId(pkg = {}) {
  return trimmed(
    pkg.pid ??
    pkg.posentegraId ??
    pkg.posentegra_id ??
    pkg.externalOrderId ??
    pkg.external_order_id ??
    pkg.externalOrderNo ??
    pkg.external_order_no ??
    pkg.platformOrderId ??
    pkg.platform_order_id ??
    pkg.trackingNo ??
    pkg.tracking_no ??
    pkg.id
  );
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function trimmed(value) {
  return String(value || "").trim();
}

function normalizePlatformName(value) {
  const incoming = trimmed(value).toLowerCase();
  return PLATFORM_ALIASES[incoming] || SUPPORTED_PLATFORMS.find((platform) => platform.toLowerCase() === incoming) || "";
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => trimmed(item)).filter(Boolean))];
}

function parseExternalRestaurantIds(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return { platform: "", restaurantId: trimmed(item) };
        }
        return {
          platform: trimmed(item?.platform || item?.source || item?.slug),
          restaurantId: trimmed(item?.restaurantId || item?.restaurant_id || item?.id),
        };
      })
      .filter((item) => item.restaurantId);
  }
  const text = trimmed(value);
  if (!text) {
    return [];
  }
  const parsed = parseJson(text, null);
  if (parsed) {
    return parseExternalRestaurantIds(parsed);
  }
  return text
    .split(/[\n,;]/)
    .map((restaurantId) => ({ platform: "", restaurantId: trimmed(restaurantId) }))
    .filter((item) => item.restaurantId);
}

function normalizeRestaurantPlatformIds(body = {}) {
  return {
    trendyolRestaurantId: trimmed(body.trendyolRestaurantId ?? body.trendyol_restaurant_id),
    yemeksepetiRestaurantId: trimmed(body.yemeksepetiRestaurantId ?? body.yemeksepeti_restaurant_id),
    getirRestaurantId: trimmed(body.getirRestaurantId ?? body.getir_restaurant_id),
    migrosRestaurantId: trimmed(body.migrosRestaurantId ?? body.migros_restaurant_id),
    posentegraId: trimmed(body.posentegraId ?? body.posentegra_id),
    externalRestaurantIds: parseExternalRestaurantIds(body.externalRestaurantIds ?? body.external_restaurant_ids),
  };
}

function assertUniqueRestaurantPlatformIds(platformIds, excludeRestaurantId = "") {
  const checks = [
    ["trendyol_restaurant_id", "Trendyol Restoran ID", platformIds.trendyolRestaurantId],
    ["yemeksepeti_restaurant_id", "Yemeksepeti Restoran ID", platformIds.yemeksepetiRestaurantId],
    ["getir_restaurant_id", "Getir Restoran ID", platformIds.getirRestaurantId],
    ["migros_restaurant_id", "Migros Yemek Restoran ID", platformIds.migrosRestaurantId],
    ["posentegra_id", "Posentegra Restoran ID", platformIds.posentegraId],
  ];
  checks.forEach(([columnName, label, value]) => {
    if (!value) return;
    const row = excludeRestaurantId
      ? db.prepare(`SELECT id, name FROM restaurants WHERE ${columnName} = ? AND id != ?`).get(value, excludeRestaurantId)
      : db.prepare(`SELECT id, name FROM restaurants WHERE ${columnName} = ?`).get(value);
    if (row) {
      throw validationError(`${label} baska bir restoranda kullaniliyor: ${row.name}`);
    }
  });

  const incoming = new Map();
  checks.forEach(([, label, value]) => {
    if (!value) return;
    if (incoming.has(value)) {
      throw validationError(`${value} birden fazla platform ID alaninda kullanilamaz.`);
    }
    incoming.set(value, label);
  });
  platformIds.externalRestaurantIds.forEach((item) => {
    if (incoming.has(item.restaurantId)) {
      throw validationError(`${item.restaurantId} birden fazla platform ID alaninda kullanilamaz.`);
    }
    incoming.set(item.restaurantId, item.platform || "External ID");
  });

  const rows = db.prepare(`
    SELECT id, name, trendyol_restaurant_id, yemeksepeti_restaurant_id, getir_restaurant_id, migros_restaurant_id, posentegra_id, external_restaurant_ids
    FROM restaurants
    WHERE id != ?
  `).all(excludeRestaurantId || "");
  for (const row of rows) {
    const ids = parseExternalRestaurantIds(row.external_restaurant_ids);
    ["trendyol_restaurant_id", "yemeksepeti_restaurant_id", "getir_restaurant_id", "migros_restaurant_id", "posentegra_id"].forEach((columnName) => {
      if (row[columnName]) ids.push({ platform: columnName, restaurantId: row[columnName] });
    });
    if (ids.some((item) => incoming.has(item.restaurantId))) {
      throw validationError(`External platform ID baska bir restoranda kullaniliyor: ${row.name}`);
    }
  }
}

function normalizePlatformInput(value) {
  const incoming = trimmed(value);
  return normalizePlatformName(incoming) || normalizePlatformFromSlug(incoming.replace(/_/g, "-"));
}

function platformSlug(platform) {
  return PLATFORM_SLUGS[platform] || trimmed(platform).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function normalizePlatformFromSlug(value) {
  const incoming = trimmed(value).toLowerCase();
  return SUPPORTED_PLATFORMS.find((platform) => platformSlug(platform) === incoming) || "";
}

function platformConfig(platform) {
  const normalizedPlatform = normalizePlatformInput(platform);
  return PLATFORM_CONFIGS[normalizedPlatform] || {
    platform: normalizedPlatform || trimmed(platform),
    mode: "webhook",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiKey", "apiSecret", "token"],
    testStrategy: "local_webhook",
    userFriendlyErrors: {},
  };
}

function platformModeFlags(platform) {
  const config = platformConfig(platform);
  return {
    config,
    webhookEnabled: config.mode === "webhook" || config.mode === "hybrid",
    pollingEnabled: config.mode === "polling" || config.mode === "hybrid",
  };
}

function platformFriendlyError(message = "", platform = "") {
  const text = trimmed(message);
  if (!text) {
    return "";
  }
  if (/Restaurant\/platform match failed|Restaurant not found/i.test(text)) {
    return "Restoran ID bu platformla eşleşmedi. Gerçek Store/Restaurant ID girilmeli.";
  }
  if (/Polling endpoint ayarl|Polling endpoint not configured|verify\/polling endpoint tanimli degil|endpoint tanimli degil/i.test(text)) {
    return "Bu platform polling desteklemiyor. Webhook modu kullanılacak.";
  }
  if (/API eri|yetki kapal|403/i.test(text)) {
    return "Bu restoran için API yetkisi kapalı. Platform panelinden API/POS entegrasyon izni açılmalı.";
  }
  if (/Unauthorized|401|API Key veya API Secret hatal/i.test(text)) {
    return "API Key, Secret veya Token hatalı olabilir.";
  }
  if (/API bilgileri eksik|credentials|missing/i.test(text)) {
    return platformConfig(platform).userFriendlyErrors.missingCredentials || "Platform bağlantı bilgileri eksik.";
  }
  return text;
}

function testStrategyForAccount(account) {
  const config = platformConfig(account?.platform);
  if (config.testStrategy === "auto") {
    return account?.pollingEnabled && !platformAccountMissingCredentials(account) ? "polling" : "local_webhook";
  }
  return config.testStrategy;
}

function parseBasicAuthHeader(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function candidateHeaderValues(req, names) {
  return names
    .map((name) => String(req.headers[name] || "").trim())
    .filter(Boolean);
}

function pickFirstValue(...values) {
  return values.find((value) => trimmed(value)) || "";
}

function joinAddress(parts) {
  return parts.map((part) => trimmed(part)).filter(Boolean).join(", ");
}

function extractDistrict(address) {
  const lowered = trimmed(address);
  if (!lowered) {
    return "";
  }

  const matched = DEFAULT_ZONES.find((zone) => lowered.toLowerCase().includes(zone.toLowerCase()));
  return matched || "";
}

function validatePackageDraft(payload) {
  const errors = [];

  if (!trimmed(payload.restaurantId)) {
    errors.push("restaurant_id zorunludur.");
  }

  if (payload.packageType && trimmed(payload.packageType).length > 60) {
    errors.push("Paket tipi en fazla 60 karakter olabilir.");
  }

  const orderAmount = Number(payload.orderAmount);
  if (Number.isNaN(orderAmount) || orderAmount <= 0) {
    errors.push("Paket tutari 0'dan buyuk olmali.");
  }

  if (payload.customerName && trimmed(payload.customerName).length < 2) {
    errors.push("Musteri adi en az 2 karakter olmali.");
  }

  if (payload.phone) {
    const phoneDigits = trimmed(payload.phone).replace(/\D/g, "");
    if (phoneDigits.length > 0 && phoneDigits.length < 10) {
      errors.push("Telefon numarasi en az 10 haneli olmali.");
    }
  }

  return errors;
}

function normalizeQuickPasteText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function findQuickPasteLabeledValue(text, labels = []) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*(.+)`, "i"));
    if (match?.[1]) {
      const value = match[1].split("\n")[0].trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function quickPasteKey(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function quickPasteLineMap(text) {
  const rows = String(text || "").split("\n").map((line) => line.trim());
  return rows.map((line, index) => {
    const match = line.match(/^([^:\-#]{2,48})\s*[:\-]\s*(.*)$/u);
    return {
      index,
      line,
      key: match ? quickPasteKey(match[1]) : "",
      value: match ? match[2].trim() : "",
      hasLabel: Boolean(match),
    };
  });
}

function quickPasteValue(text, labels = []) {
  const wanted = new Set(labels.map(quickPasteKey));
  const row = quickPasteLineMap(text).find((item) => item.hasLabel && wanted.has(item.key) && item.value);
  return row?.value || "";
}

function quickPasteBlock(text, labels = []) {
  const rows = quickPasteLineMap(text);
  const wanted = new Set(labels.map(quickPasteKey));
  const stopLabels = new Set([
    "not", "aciklama", "adres tarifi", "kurye notu", "musteri notu", "siparis icerigi",
    "urunler", "odeme", "odeme tipi", "tutar", "toplam", "toplam tutar", "telefon",
    "tel", "musteri", "musteri adi", "ad soyad", "siparis no", "order id"
  ]);
  const start = rows.find((item) => item.hasLabel && wanted.has(item.key));
  if (!start) return "";
  const parts = [];
  if (start.value) parts.push(start.value);
  for (let index = start.index + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.line) {
      if (parts.length) break;
      continue;
    }
    if (row.hasLabel && stopLabels.has(row.key)) break;
    parts.push(row.line);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function detectQuickPastePlatform(text) {
  if (/yemek\s*sepeti|yemeksepeti|\bys\b/i.test(text)) return "Yemeksepeti";
  if (/getir/i.test(text)) return "GetirYemek";
  if (/trendyol/i.test(text)) return "Trendyol Yemek";
  if (/migros/i.test(text)) return "Migros Yemek";
  return "Hizli Platform";
}

function parseQuickPasteTextSmart(rawText) {
  const text = normalizeQuickPasteText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "") : "";
  const platform = detectQuickPastePlatform(text);
  const customerName = quickPasteValue(text, ["Musteri", "Musteri Adi", "Ad Soyad", "Adi Soyadi", "Alici"]);
  const labeledPayment = quickPasteValue(text, ["Odeme", "Odeme Tipi", "Payment", "Payment Method"]);
  const paymentMethod = labeledPayment || (/nakit kapida|kapida nakit|nakit/i.test(text)
    ? "Nakit"
    : /online|kart|kredi karti|pos/i.test(text)
      ? "Online Odeme"
      : "");
  const customerNote = quickPasteValue(text, ["Not", "Aciklama", "Adres Tarifi", "Kurye Notu", "Musteri Notu"]);
  const amountMatch = text.match(/(?:toplam\s*tutar|toplam|tutar|odeme)\s*[:\-]?\s*(?:tl|try|₺)?\s*([\d\.,]+)/i) ||
    text.match(/([\d\.,]+)\s*(?:tl|try|₺)/i);
  const orderAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : 0;
  const orderNo = quickPasteValue(text, ["Siparis No", "Siparis ID", "Order No", "Order ID"]) ||
    (text.match(/#\s*([A-Z0-9][A-Z0-9\-]{4,})/i)?.[1] || "");
  const labeledAddress = quickPasteBlock(text, ["Teslimat Adresi", "Adres", "Musteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|tel|odeme|musteri|not|aciklama|toplam|tutar|urun|siparis)\b/i.test(quickPasteKey(line)))
    .sort((left, right) => right.length - left.length)[0] || "";

  return {
    customerName,
    phone,
    customerAddress: labeledAddress || longAddressLine,
    paymentMethod,
    customerNote,
    packageType: `${platform} Siparisi${orderNo ? ` - ${orderNo}` : ""}`,
    platform,
    orderNo,
    orderAmount,
  };
}

function parseQuickPasteText(rawText) {
  return parseQuickPasteTextSmart(rawText);
  const text = normalizeQuickPasteText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
  const phone = phoneMatch
    ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "")
    : "";
  const customerName = findQuickPasteLabeledValue(text, ["Musteri", "Müşteri", "Ad Soyad", "Adı Soyadı", "Alici", "Alıcı"]);
  const paymentMethod = (() => {
    const labeled = findQuickPasteLabeledValue(text, ["Odeme", "Ödeme", "Odeme Tipi", "Ödeme Tipi"]);
    if (labeled) {
      return labeled;
    }
    if (/nakit kapida|kapida nakit|nakit/i.test(text)) {
      return "Nakit";
    }
    if (/online|kart|kredi karti|kredi kartı|pos/i.test(text)) {
      return "Online Odeme";
    }
    return "";
  })();
  const customerNote = findQuickPasteLabeledValue(text, ["Not", "Aciklama", "Açıklama", "Kurye Notu", "Musteri Notu", "Müşteri Notu"]);
  const amountMatch = text.match(/(?:toplam|tutar|odeme|ödeme)\s*[:\-]?\s*[₺₸]?\s*([\d\.,]+)/i) || text.match(/[₺₸]\s*([\d\.,]+)/);
  const orderAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : 0;
  const packageType = findQuickPasteLabeledValue(text, ["Paket Tipi", "Urun", "Ürün", "Siparis", "Sipariş"]) || "Hizli Platform Siparisi";
  const labeledAddress = findQuickPasteLabeledValue(text, ["Adres", "Teslimat Adresi", "Musteri Adresi", "Müşteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|odeme|ödeme|musteri|müşteri|not|aciklama|açıklama|toplam|tutar)\b/i.test(line))
    .sort((left, right) => right.length - left.length)[0] || "";
  const customerAddress = labeledAddress || longAddressLine;

  return {
    customerName,
    phone,
    customerAddress,
    paymentMethod,
    customerNote,
    packageType,
    orderAmount,
  };
}

function buildRestaurantPackageRecord(restaurantRow, draft = {}, options = {}) {
  const createdAt = nowIso();
  const externalOrderId = options.externalOrderId || `MANUAL-${Date.now()}`;
  const normalizedSource = normalizePlatformKey(draft.source);
  const isQuickPasteOrder = ["platform_manual", "platform_extension", "platform_extension_auto"].includes(normalizedSource);
  const targetSourcePlatform = draft.sourcePlatform || (isQuickPasteOrder ? "Hizli Yapistir" : "Dis Manuel Paket");
  const methodCode = normalizePaymentMethodCode(draft.paymentMethod) || "paid_online";
  const targetPaymentMethod = PAYMENT_METHOD_LABELS[methodCode] || draft.paymentMethod || "Panel Kaydi";
  const targetPaymentStatus = draft.paymentStatus || paymentStatusForMethod(methodCode);

  return {
    id: uid("pkg"),
    trackingNo: generateTrackingNo(),
    restaurantId: restaurantRow.id,
    source: isQuickPasteOrder
      ? (normalizedSource === "platform_extension_auto"
        ? "platform_extension_auto"
        : normalizedSource === "platform_extension"
          ? "platform_extension"
          : "platform_manual")
      : "external_manual",
    deliveryAddress: draft.deliveryAddress || "-",
    packageType: draft.packageType || "Standart Paket",
    sourcePlatform: targetSourcePlatform,
    externalOrderNo: externalOrderId,
    externalOrderId,
    posentegraId: resolvePackagePosentegraId({
      pid: draft.pid,
      posentegraId: draft.posentegraId ?? draft.posentegra_id,
      externalOrderId,
    }),
    recipient: draft.customerName || restaurantRow.name,
    phone: draft.phone || "-",
    address: draft.deliveryAddress || "-",
    customerAddress: draft.customerAddress || draft.deliveryAddress || "-",
    customerLatitude: null,
    customerLongitude: null,
    zone: restaurantRow.zone,
    eta: "Planlanacak",
    paymentMethod: targetPaymentMethod,
    orderAmount: draft.orderAmount,
    paymentStatus: normalizePaymentStatus(targetPaymentStatus, targetPaymentMethod),
    paymentCollectedBy: normalizeCollectedBy(targetPaymentStatus),
    collectedAmount: [PAID_ONLINE_PAYMENT_STATUS, RESTAURANT_COLLECTED_PAYMENT_STATUS, COLLECTED_PAYMENT_STATUS].includes(normalizePaymentStatus(targetPaymentStatus, targetPaymentMethod))
      ? normalizeMoney(draft.orderAmount)
      : 0,
    courierCollectionNote: "",
    restaurantCustomerId: draft.restaurantCustomerId || null,
    latitude: restaurantRow.x,
    longitude: restaurantRow.y,
    note: isQuickPasteOrder
      ? `${draft.packageType} hizli siparis yapistir ile olusturuldu.${draft.rawText ? " Ham metin kaydi var." : ""}`
      : `${draft.packageType} restoran panelinden olusturuldu.`,
    customerNote: draft.customerNote,
    rawPayload: draft.rawText ? { quickPasteText: draft.rawText } : null,
    status: draft.requestedStatus || AWAITING_ASSIGNMENT_STATUS,
    assignmentStatus: "unassigned",
    assignedCourierId: null,
    assignedCourierName: null,
    assignedAt: null,
    acceptedAt: null,
    onRouteAt: null,
    deliveredAt: null,
    failedAt: null,
    distanceKm: null,
    failureReason: "",
    lastAssignmentAttemptAt: null,
    lastAssignmentError: "",
    assignmentReason: isQuickPasteOrder
      ? "Hizli siparis kaydi alindi, restoran onayi bekliyor."
      : "Yeni manuel paket kaydi alindi, restoran onayi bekliyor.",
    createdAt,
    updatedAt: createdAt,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseLatitudeLongitude(body, latitudeKey = "latitude", longitudeKey = "longitude") {
  return {
    latitude: Number(body[latitudeKey] ?? body.x),
    longitude: Number(body[longitudeKey] ?? body.y),
  };
}

function normalizeMoney(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  let raw = String(value).trim().replace(/[^\d,.-]/g, "");
  if (raw.includes(",") && raw.includes(".")) {
    raw = raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (raw.includes(",")) {
    raw = raw.replace(",", ".");
  }
  const normalized = Number(raw);
  if (Number.isNaN(normalized) || normalized < 0) {
    return fallback;
  }

  return Number(normalized.toFixed(2));
}

function coordinatesAreValid(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function moneyToCents(value) {
  return Math.round(normalizeMoney(value) * 100);
}

function centsToMoney(value) {
  return Number((Number(value || 0) / 100).toFixed(2));
}

function validateRestaurantDraft(body) {
  const { latitude, longitude } = parseLatitudeLongitude(body);
  const portalUsername = trimmed(body.portalUsername || body.username);
  const portalPassword = String(body.portalPassword || body.password || "");
  const platformIds = normalizeRestaurantPlatformIds(body);
  const draft = {
    name: trimmed(body.name),
    zone: trimmed(body.zone),
    latitude,
    longitude,
    portalUsername,
    portalPassword,
    platforms: Array.isArray(body.platforms) ? body.platforms.map((item) => trimmed(item)).filter(Boolean) : [],
    ...platformIds,
  };

  if (!draft.name || !draft.zone || Number.isNaN(draft.latitude) || Number.isNaN(draft.longitude)) {
    throw validationError("Restoran bilgileri eksik.");
  }

  if (!coordinatesAreValid(draft.latitude, draft.longitude)) {
    throw validationError("Restoran koordinatlari gecersiz.");
  }

  return draft;
}

function validatePlatformAccountDraft(body) {
  const restaurantId = trimmed(body.restaurantId ?? body.restaurant_id);
  const platform = normalizePlatformInput(body.platform);
  const externalStoreId = trimmed(body.externalStoreId ?? body.external_store_id ?? body.platformRestaurantId ?? body.platform_restaurant_id);
  const webhookSecret = trimmed(
    body.webhookSecret ??
    body.webhook_secret ??
    body.staticToken ??
    body.static_token ??
    body.apiKey ??
    body.apiPassword
  );

  if (!restaurantId) {
    throw validationError("restaurant_id zorunludur.");
  }

  if (!platform) {
    throw validationError("Desteklenen bir platform secmelisin.");
  }

  if (!externalStoreId) {
    throw validationError("Platform store/vendor kimligi zorunludur.");
  }

  const config = platformConfig(platform);
  const normalizedWebhookSecret = webhookSecret || createWebhookSecret();
  const normalizedApiSecret = platform === "POS"
    ? trimmed(body.apiSecret ?? body.api_secret ?? body.webhookSecret ?? body.webhook_secret)
    : trimmed(body.apiSecret ?? body.api_secret);
  const flags = platformModeFlags(platform);

  return {
    restaurantId,
    platform,
    platformConfig: config,
    mode: config.mode,
    testStrategy: config.testStrategy,
    externalStoreId,
    externalId: externalStoreId,
    externalMerchantId: trimmed(body.externalMerchantId ?? body.external_merchant_id),
    apiUsername: trimmed(body.apiUsername),
    apiPassword: String(body.apiPassword || ""),
    apiKey: trimmed(body.apiKey),
    apiSecret: normalizedApiSecret,
    accessToken: trimmed(body.accessToken ?? body.token),
    token: trimmed(body.token ?? body.accessToken),
    refreshToken: trimmed(body.refreshToken),
    tokenExpiresAt: trimmed(body.tokenExpiresAt),
    callbackUrl: trimmed(body.callbackUrl),
    integrationReferenceCode: trimmed(body.integrationRefCode ?? body.integration_ref_code ?? body.integrationReferenceCode ?? body.integration_reference_code),
    posSecretKey: trimmed(body.posSecretKey ?? body.pos_secret_key),
    storeFrontCode: trimmed(body.storeFrontCode),
    chainId: trimmed(body.chainId),
    vendorId: trimmed(body.vendorId),
    authType: trimmed(body.authType || body.auth_type || body.webhookAuthType) || PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
    webhookAuthType: PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
    webhookApiKey: "",
    webhookUsername: "",
    webhookPassword: "",
    staticToken: normalizedWebhookSecret,
    webhookSecret: normalizedWebhookSecret,
    pollingEnabled: flags.pollingEnabled,
    webhookEnabled: flags.webhookEnabled,
    active: body.active !== false,
    settings: {
      ...(typeof body.settings === "object" && body.settings ? body.settings : {}),
      platformMode: config.mode,
      testStrategy: config.testStrategy,
      requiredFields: config.requiredFields,
    },
  };
}

function normalizeIncomingOrderItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      const name = trimmed(item?.name ?? item?.productName ?? item?.title ?? item?.product);
      const quantity = Number(item?.quantity ?? item?.qty ?? item?.count ?? 1);
      const price = normalizeMoney(item?.price ?? item?.unitPrice ?? item?.totalPrice ?? 0);
      return {
        id: trimmed(item?.id) || `item-${index + 1}`,
        name: name || `Urun ${index + 1}`,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        price,
      };
    })
    .filter((item) => item.name);
}

function normalizeOrder(platform, rawBody) {
  const normalizedPlatform = normalizePlatformInput(platform);
  const adapter = getPlatformAdapter(normalizePlatformKey(normalizedPlatform || platform));
  const normalized = adapter.normalizeOrder(rawBody || {});
  const canonical = {
    ...normalized,
    platform: normalizedPlatform,
    platformRestaurantId: trimmed(normalized.platformRestaurantId),
    orderId: trimmed(normalized.orderId),
    customerName: trimmed(normalized.customerName),
    phone: trimmed(normalized.phone),
    address: trimmed(normalized.address),
    items: normalizeIncomingOrderItems(normalized.items),
    totalPrice: normalizeMoney(normalized.totalPrice),
    paymentMethod: trimmed(normalized.paymentMethod) || "Online Odeme",
    customerNote: trimmed(normalized.customerNote),
    customerLatitude: Number.isFinite(Number(normalized.customerLatitude)) ? Number(normalized.customerLatitude) : null,
    customerLongitude: Number.isFinite(Number(normalized.customerLongitude)) ? Number(normalized.customerLongitude) : null,
    customerAddress: trimmed(normalized.customerAddress || normalized.address),
    rawPayload: normalized.rawPayload || rawBody || {},
  };

  if (
    !canonical.platform ||
    !canonical.platformRestaurantId ||
    !canonical.orderId ||
    !canonical.customerName ||
    !canonical.phone ||
    !canonical.address ||
    canonical.totalPrice <= 0
  ) {
    throw validationError("Platform siparis verisi eksik.");
  }

  return canonical;
}

function validateAdminLoginDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  const password = String(body.password || "");

  if (!username || !password) {
    throw validationError("Admin kullanici adi ve sifre zorunludur.");
  }

  return { username, password };
}

function validateRestaurantLoginDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  const password = String(body.password || "");
  const restaurantId = trimmed(body.restaurantId ?? body.restaurant_id ?? body.headerRestaurantId ?? body.header_restaurant_id);
  const apiKey = trimmed(body.apiKey ?? body.api_key ?? body.headerApiKey ?? body.header_api_key);

  if (username && password) {
    return { mode: "portal", username, password };
  }

  if (restaurantId && apiKey) {
    return { mode: "integration", restaurantId, apiKey };
  }

  throw validationError("Restoran girisi icin kullanici/sifre veya restoranId/apiKey gerekli.");
}

function validateCourierDraft(body) {
  const { latitude, longitude } = parseLatitudeLongitude(body);
  const draft = {
    username: trimmed(body.username).toLowerCase(),
    password: String(body.password || ""),
    name: trimmed(body.name),
    zone: trimmed(body.zone),
    latitude,
    longitude,
    available: Boolean(body.available),
  };

  if (!draft.name || !draft.zone || !draft.username || !draft.password || Number.isNaN(draft.latitude) || Number.isNaN(draft.longitude)) {
    throw validationError("Kurye bilgileri eksik.");
  }


  if (!coordinatesAreValid(draft.latitude, draft.longitude)) {
    throw validationError("Kurye koordinatlari gecersiz.");
  }

  if (draft.password.length < 6) {
    throw validationError("Kurye sifresi en az 6 karakter olmali.");
  }

  return draft;
}

function validateRestaurantSessionDraft(body) {
  const restaurantId = trimmed(body.restaurantId);
  const apiKey = trimmed(body.apiKey);

  if (!restaurantId || !apiKey) {
    throw validationError("Restoran kimligi ve API key zorunludur.");
  }

  return { restaurantId, apiKey };
}

function validateCourierLoginDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  const password = String(body.password || "");

  if (!username || !password) {
    throw validationError("Kullanici adi ve sifre zorunludur.");
  }

  return { username, password };
}

function validateIntegrationDraft(body, restaurant) {
  const paymentMethod = trimmed(body.paymentMethod);
  const createdAt = nowIso();
  const items = Array.isArray(body.items) ? body.items : [];
  const externalOrderNo = trimmed(body.externalOrderNo);
  const externalOrderId = trimmed(body.externalOrderId || body.externalOrderNo);
  const pkg = {
    id: uid("pkg"),
    trackingNo: generateTrackingNo(),
    restaurantId: restaurant.id,
    source: trimmed(body.source) || "platform_webhook",
    sourcePlatform: trimmed(body.sourcePlatform),
    platformRestaurantId: trimmed(body.platformRestaurantId ?? body.platform_restaurant_id ?? body.externalRestaurantId ?? body.external_restaurant_id),
    externalRestaurantId: trimmed(body.externalRestaurantId ?? body.external_restaurant_id ?? body.platformRestaurantId ?? body.platform_restaurant_id),
    posentegraId: resolvePackagePosentegraId({
      pid: body.pid,
      posentegraId: body.posentegraId ?? body.posentegra_id,
      externalOrderId,
      externalOrderNo,
    }),
    externalOrderNo,
    externalOrderId,
    recipient: trimmed(body.recipient),
    phone: trimmed(body.phone),
    address: trimmed(body.address),
    zone: trimmed(body.zone || restaurant.zone),
    eta: trimmed(body.eta) || `${suggestedRestaurantPrepMinutes(trimmed(body.zone || restaurant.zone))} dk`,
    paymentMethod,
    orderAmount: normalizeMoney(body.orderAmount ?? body.amount ?? body.totalAmount ?? body.total_price),
    paymentStatus: normalizePaymentStatus(body.paymentStatus, paymentMethod),
    latitude: Number(body.latitude ?? body.x ?? restaurant.latitude),
    longitude: Number(body.longitude ?? body.y ?? restaurant.longitude),
    note: trimmed(body.note),
    customerNote: trimmed(body.customerNote ?? body.customer_note),
    customerLatitude: Number.isFinite(Number(body.customerLatitude ?? body.customer_lat ?? body.customerLat))
      ? Number(body.customerLatitude ?? body.customer_lat ?? body.customerLat)
      : null,
    customerLongitude: Number.isFinite(Number(body.customerLongitude ?? body.customer_lng ?? body.customerLng))
      ? Number(body.customerLongitude ?? body.customer_lng ?? body.customerLng)
      : null,
    customerAddress: trimmed(body.customerAddress ?? body.customer_address ?? body.address),
    items,
    rawPayload: body.rawPayload ?? body.raw_payload ?? null,
    status: trimmed(body.status) ? normalizeStatus(body.status) : PENDING_STATUS,
    assignmentStatus: "pending",
    assignedCourierId: null,
    assignedCourierName: null,
    distanceKm: null,
    assignedAt: null,
    acceptedAt: null,
    onRouteAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: "",
    lastAssignmentAttemptAt: null,
    lastAssignmentError: "",
    assignmentReason: "Atama bekleniyor.",
    createdAt,
    updatedAt: createdAt,
  };

  if (
    !pkg.restaurantId ||
    !pkg.sourcePlatform ||
    !pkg.externalOrderNo ||
    !pkg.recipient ||
    !pkg.phone ||
    !pkg.address ||
    !pkg.zone ||
    !pkg.eta ||
    !pkg.paymentMethod ||
    pkg.orderAmount <= 0 ||
    Number.isNaN(pkg.latitude) ||
    Number.isNaN(pkg.longitude)
  ) {
    throw validationError("Siparis verisi eksik.");
  }

  return pkg;
}

function normalizeFeederIntegrationDraft(body) {
  const customer = body?.customer && typeof body.customer === "object" ? body.customer : {};
  const addressValue = body?.address;
  const address =
    typeof addressValue === "object" && addressValue !== null
      ? trimmed(addressValue.full || addressValue.text || addressValue.address || addressValue.line1)
      : trimmed(addressValue);
  const orderId = trimmed(body.orderId ?? body.order_id ?? body.externalOrderId ?? body.external_order_id);
  const platform = normalizePlatformInput(body.platform ?? body.sourcePlatform ?? body.source_platform);
  const customerName = trimmed(body.customerName ?? body.customer_name ?? customer.name ?? customer.fullName ?? customer.full_name);
  const phone = trimmed(body.phone ?? customer.phone ?? customer.phoneNumber ?? customer.phone_number);
  const price = normalizeMoney(body.price ?? body.totalPrice ?? body.total_price ?? body.orderAmount ?? body.amount);

  if (!trimmed(body.restaurantId ?? body.restaurant_id)) {
    throw validationError("restaurantId zorunludur.");
  }
  if (!orderId || !customerName || !phone || !address || price <= 0 || !platform) {
    throw validationError("orderId, customer, address, price ve platform zorunludur.");
  }

  return {
    restaurantId: trimmed(body.restaurantId ?? body.restaurant_id),
    source: "platform_api",
    sourcePlatform: platform,
    externalOrderNo: orderId,
    externalOrderId: orderId,
    recipient: customerName,
    phone,
    address,
    zone: trimmed(body.zone),
    paymentMethod: trimmed(body.paymentMethod ?? body.payment_method) || "Online Odeme",
    orderAmount: price,
    amount: price,
    items: normalizeIncomingOrderItems(body.items),
    note: trimmed(body.note),
    customerNote: trimmed(body.customerNote ?? body.customer_note),
    customerLatitude: body.customerLatitude ?? body.customer_lat ?? body.customerLat,
    customerLongitude: body.customerLongitude ?? body.customer_lng ?? body.customerLng,
    customerAddress: trimmed(body.customerAddress ?? body.customer_address) || address,
    latitude: body.latitude ?? body.x,
    longitude: body.longitude ?? body.y,
    rawPayload: body.rawPayload ?? body.raw_payload ?? body,
  };
}

function normalizeStatus(status) {
  return LEGACY_STATUS_MAP[String(status || "").trim()] || PENDING_STATUS;
}

function isKnownPackageStatus(status) {
  const incoming = String(status || "").trim();
  return Boolean(incoming) && (KNOWN_PACKAGE_STATUSES.has(incoming) || Object.prototype.hasOwnProperty.call(LEGACY_STATUS_MAP, incoming));
}

function canTransitionStatus(fromStatus, toStatus) {
  const current = normalizeStatus(fromStatus);
  const next = normalizeStatus(toStatus);
  return current === next || (STATUS_TRANSITIONS[current] || []).includes(next);
}

function normalizePaymentStatus(paymentStatus, paymentMethod = "") {
  const incoming = trimmed(paymentStatus).toLowerCase();
  if (VALID_PAYMENT_STATUSES.has(incoming)) {
    return incoming;
  }

  const loweredMethod = trimmed(paymentMethod).toLowerCase();
  const methodCode = normalizePaymentMethodCode(paymentMethod);
  if (methodCode === "paid_online") return PAID_ONLINE_PAYMENT_STATUS;
  if (methodCode === "cash_on_delivery") return CASH_EXPECTED_PAYMENT_STATUS;
  if (methodCode === "card_on_delivery") return CREDIT_CARD_PAYMENT_STATUS;
  if (methodCode === "restaurant_collected") return RESTAURANT_COLLECTED_PAYMENT_STATUS;
  if (methodCode === "collected") return COLLECTED_PAYMENT_STATUS;
  if (methodCode === "payment_issue") return PAYMENT_ISSUE_STATUS;
  if (loweredMethod.includes("nakit")) {
    return CASH_EXPECTED_PAYMENT_STATUS;
  }
  if (loweredMethod.includes("online")) {
    return PAID_ONLINE_PAYMENT_STATUS;
  }
  if (loweredMethod.includes("kart") || loweredMethod.includes("kredi") || loweredMethod.includes("pos")) {
    return CREDIT_CARD_PAYMENT_STATUS;
  }
  if (loweredMethod.includes("edilemedi") || loweredMethod.includes("alinamadi") || loweredMethod.includes("alınamadı") || loweredMethod.includes("payment_issue")) {
    return PAYMENT_ISSUE_STATUS;
  }

  return UNPAID_PAYMENT_STATUS;
}

function normalizePaymentMethodCode(value) {
  const incoming = trimmed(value).toLowerCase();
  if (VALID_PAYMENT_METHODS.has(incoming)) {
    return incoming;
  }
  if (
    incoming.includes("pay_with_") ||
    incoming.includes("meal_card") ||
    incoming.includes("mealcard") ||
    incoming.includes("online_paid") ||
    incoming.includes("paid_online")
  ) return "paid_online";
  if (incoming.includes("online")) return "paid_online";
  if (incoming.includes("nakit") || incoming.includes("cash")) return "cash_on_delivery";
  if (incoming.includes("kart") || incoming.includes("kredi") || incoming.includes("card") || incoming.includes("debit") || incoming.includes("pos")) return "card_on_delivery";
  if (incoming.includes("restoran")) return "restaurant_collected";
  if (incoming.includes("edilemedi") || incoming.includes("alinamadi") || incoming.includes("alınamadı") || incoming.includes("payment_issue")) return "payment_issue";
  if (incoming.includes("tahsil")) return "collected";
  if (incoming.includes("panel kaydi") || incoming.includes("panel kaydı") || incoming.includes("platform odeme") || incoming.includes("platform ödeme")) return "paid_online";
  return "";
}

function paymentMethodLabel(value) {
  const code = normalizePaymentMethodCode(value);
  return code ? PAYMENT_METHOD_LABELS[code] : trimmed(value);
}

function paymentStatusForMethod(methodCode) {
  switch (normalizePaymentMethodCode(methodCode)) {
    case "cash_on_delivery":
      return CASH_EXPECTED_PAYMENT_STATUS;
    case "card_on_delivery":
      return CREDIT_CARD_PAYMENT_STATUS;
    case "paid_online":
      return PAID_ONLINE_PAYMENT_STATUS;
    case "restaurant_collected":
      return RESTAURANT_COLLECTED_PAYMENT_STATUS;
    case "collected":
      return COLLECTED_PAYMENT_STATUS;
    case "payment_issue":
      return PAYMENT_ISSUE_STATUS;
    default:
      return UNPAID_PAYMENT_STATUS;
  }
}

function normalizeCollectedBy(paymentStatus, fallback = "") {
  const status = normalizePaymentStatus(paymentStatus);
  if ([CASH_COLLECTED_PAYMENT_STATUS, CREDIT_CARD_COLLECTED_PAYMENT_STATUS].includes(status)) {
    return "courier";
  }
  if ([RESTAURANT_COLLECTED_PAYMENT_STATUS, PAID_ONLINE_PAYMENT_STATUS].includes(status)) {
    return "restaurant";
  }
  if (status === COLLECTED_PAYMENT_STATUS) {
    return trimmed(fallback) || "restaurant";
  }
  return trimmed(fallback);
}

function validatePaymentDraft({ paymentMethod, paymentStatus, orderAmount }) {
  const methodCode = normalizePaymentMethodCode(paymentMethod);
  if (!methodCode) {
    return { error: "Gecerli bir odeme tipi secilmelidir.", methodCode: "", paymentStatus: "" };
  }
  const amount = normalizeMoney(orderAmount);
  if (["cash_on_delivery", "card_on_delivery"].includes(methodCode) && amount <= 0) {
    return { error: "Kapida tahsilat icin paket tutari 0'dan buyuk olmalidir.", methodCode, paymentStatus: "" };
  }
  const status = paymentStatus ? normalizePaymentStatus(paymentStatus, PAYMENT_METHOD_LABELS[methodCode]) : paymentStatusForMethod(methodCode);
  return { error: "", methodCode, paymentStatus: status };
}

function suggestedRestaurantPrepMinutes(zone, state = null) {
  const activeStatuses = [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS];
  let packageCount = 0;
  let busyCouriers = 0;
  let onlineCouriers = 0;

  if (state) {
    packageCount = state.packages.filter((pkg) => pkg.zone === zone && activeStatuses.includes(normalizeStatus(pkg.status))).length;
    const zoneCouriers = state.couriers.filter((courier) => courier.zone === zone);
    busyCouriers = zoneCouriers.filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_BUSY_STATUS).length;
    onlineCouriers = zoneCouriers.filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_ONLINE_STATUS).length;
  } else {
    packageCount = db.prepare(`
      SELECT COUNT(*) AS count FROM packages
      WHERE zone = ? AND status IN (${activeStatuses.map(() => "?").join(",")})
    `).get(zone, ...activeStatuses).count;
    busyCouriers = countTable("couriers", "zone = ? AND status = ?", [zone, COURIER_BUSY_STATUS]);
    onlineCouriers = countTable("couriers", "zone = ? AND status = ?", [zone, COURIER_ONLINE_STATUS]);
  }

  const pressure = packageCount + (busyCouriers * 2) - onlineCouriers;
  return Math.max(5, Math.min(15, 5 + Math.max(0, pressure)));
}

function normalizeCourierStatus(status, available = false) {
  const incoming = trimmed(status).toLowerCase();
  if ([COURIER_OFFLINE_STATUS, COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(incoming)) {
    return incoming;
  }

  return available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS;
}

function normalizeCourierFailureReason(value) {
  const normalized = trimmed(value).toLowerCase().replaceAll(" ", "_");
  return COURIER_FAILURE_REASONS.has(normalized) ? normalized : "";
}

function isCourierIssueCancellation(pkg) {
  return normalizeStatus(pkg?.status) === CANCELED_STATUS && Boolean(
    normalizeCourierFailureReason(pkg?.failureReason || pkg?.failure_reason || "")
  );
}

function countsForCourierPackageFee(pkg) {
  return normalizeStatus(pkg?.status) === DELIVERED_STATUS || isCourierIssueCancellation(pkg);
}

function courierPackageFeeTimestamp(pkg) {
  return pkg?.deliveredAt || pkg?.delivered_at || pkg?.failedAt || pkg?.failed_at || pkg?.updatedAt || pkg?.updated_at || pkg?.createdAt || pkg?.created_at;
}

function normalizeOrderSource(source, sourcePlatform = "") {
  const incoming = trimmed(source).toLowerCase();
  if (incoming === "manual" || incoming === "external_manual" || incoming === "restaurant_panel") {
    if (incoming === "restaurant_panel") {
      return "external_manual";
    }
    return incoming;
  }

  if (trimmed(sourcePlatform).toLowerCase() === "restaurant panel") {
    return "external_manual";
  }

  if (incoming === "platform_webhook" || incoming === "platform_api") {
    return incoming;
  }

  return incoming || "platform_api";
}

function isActivePackageStatus(status) {
  return [ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(normalizeStatus(status));
}

function assignmentStatusForOrder(status) {
  const normalized = normalizeStatus(status);
  if (normalized === PENDING_APPROVAL_STATUS) {
    return "pending_approval";
  }
  if (normalized === PREPARING_STATUS) {
    return "waiting_courier";
  }
  if (normalized === ASSIGNED_STATUS || normalized === ACCEPTED_BY_COURIER_STATUS || normalized === ON_ROUTE_STATUS || normalized === DELIVERED_STATUS) {
    return "assigned";
  }
  if (normalized === FAILED_STATUS) {
    return "failed";
  }
  if (normalized === REJECTED_STATUS) {
    return "rejected";
  }
  if (normalized === CANCELED_STATUS) {
    return "cancelled";
  }
  return "pending";
}

function nowIso() {
  return new Date().toISOString();
}

function plusHoursIso(value, hours) {
  const base = new Date(value);
  base.setHours(base.getHours() + hours);
  return base.toISOString();
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((value) => value.trim().replace(/^\[|\]$/g, ""))
      .filter((value) => net.isIP(value));
    if (forwarded.length) {
      return forwarded[forwarded.length - 1];
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function requestProtocol(req) {
  if (TRUST_PROXY) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (forwardedProto) {
      return forwardedProto;
    }
  }

  return req?.socket?.encrypted ? "https" : "http";
}

function isSecureRequest(req) {
  return requestProtocol(req) === "https";
}

function isLocalHostRequest(req) {
  const hostHeader = String(req?.headers?.host || "").toLowerCase();
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  const host = req?.headers?.host || `localhost:${PORT}`;
  return `${requestProtocol(req)}://${host}`;
}

function originForCors(req) {
  const origin = trimmed(req?.headers?.origin).replace(/\/+$/, "");
  if (!origin) {
    return "";
  }

  if (CORS_ALLOWED_ORIGINS.includes("*") || CORS_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  try {
    const originUrl = new URL(origin);
    if (originUrl.host === req?.headers?.host || originUrl.origin === new URL(requestBaseUrl(req)).origin) {
      return origin;
    }
  } catch {}

  return "";
}

async function applyRateLimit(req, scope, rule) {
  const key = `${scope}:${clientIp(req)}`;
  const result = await rateLimitStore.increment(key, rule);
  if (result.limited) {
    logger.warn("Rate limit exceeded", {
      scope,
      ip: clientIp(req),
      retryAfter: result.retryAfter,
      requestId: req.requestId,
      store: rateLimitStore.health().mode,
    });
  }
  return result.limited ? result.retryAfter : null;
}

function productionDisabled(res) {
  sendJson(res, 404, { error: "Bu islem production ortaminda kullanilamaz." });
}

function sendRateLimited(res, retryAfter) {
  res.setHeader("Retry-After", String(retryAfter));
  sendJson(res, 429, {
    ok: false,
    error: "Too many requests",
    code: "rate_limited",
    retryAfter,
  });
}

function writeSecurityHeaders(res) {
  const req = res._deliveraRequest;
  const requestPath = String(req?.url || "").split("?")[0];
  const isCourierDesignPage = requestPath === "/courier.html" || requestPath.startsWith("/courier-");
  const isRestaurantDesignPage = requestPath === "/restaurant.html" || requestPath.startsWith("/restaurant-design-");
  const corsOrigin = originForCors(req);
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req?.headers?.["access-control-request-headers"] || "Content-Type, Authorization, X-API-Key, X-Platform-Secret, X-Webhook-Secret");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", isCourierDesignPage || isRestaurantDesignPage
    ? "default-src 'self'; style-src 'self' https://fonts.googleapis.com https://unpkg.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com https://unpkg.com; script-src 'self' https://cdn.tailwindcss.com https://unpkg.com 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https://lh3.googleusercontent.com https://tile.openstreetmap.org; connect-src 'self' https://router.project-osrm.org; frame-src 'self' https://www.google.com https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    : "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://router.project-osrm.org; frame-src https://www.google.com https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (FORCE_HTTPS || NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedHash, "hex"));
}

function signWebhook(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function createApiKey() {
  return `delv_${crypto.randomBytes(12).toString("hex")}`;
}

function createWebhookSecret() {
  return `whsec_${crypto.randomBytes(18).toString("hex")}`;
}

function createSessionToken() {
  return `sess_${crypto.randomBytes(18).toString("hex")}`;
}

function createRefreshToken() {
  return `rfs_${crypto.randomBytes(24).toString("hex")}`;
}

function createPasswordResetToken() {
  return `rst_${crypto.randomBytes(24).toString("hex")}`;
}

function hashOpaqueToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createIntegrationSecret(prefix = "hook") {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function createPortalUsername(name) {
  const base = trimmed(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 14) || "restaurant";
  return `${base}${Math.floor(100 + Math.random() * 900)}`;
}

function sanitizeCourier(courier) {
  const { passwordHash, passwordSalt, ...safeCourier } = courier;
  return safeCourier;
}

function sanitizeRestaurant(restaurant, includeSecrets = false) {
  const { passwordHash, passwordSalt, ...safeRestaurant } = restaurant;
  if (includeSecrets) {
    return {
      ...safeRestaurant,
      apiKey: restaurant.apiKey ? "Kayitli" : "",
      webhookSecret: restaurant.webhookSecret ? "Kayitli" : "",
      hasApiKey: Boolean(restaurant.apiKey),
      hasWebhookSecret: Boolean(restaurant.webhookSecret),
    };
  }

  const { apiKey, webhookSecret, ...publicRestaurant } = safeRestaurant;
  return {
    ...publicRestaurant,
    hasApiKey: Boolean(apiKey),
    hasWebhookSecret: Boolean(webhookSecret),
  };
}

function maskSecret(value) {
  const secret = trimmed(value);
  if (!secret) {
    return "";
  }
  if (secret.length <= 6) {
    return "****";
  }
  return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
}

function sanitizePlatformAccount(account, includeSecrets = false) {
  const config = platformConfig(account.platform);
  const safeAccount = {
    id: account.id,
    restaurantId: account.restaurantId,
    platform: account.platform,
    platformSlug: platformSlug(account.platform),
    externalId: account.externalId,
    externalStoreId: account.externalStoreId,
    externalMerchantId: account.externalMerchantId,
    apiUsername: account.apiUsername,
    hasApiKey: Boolean(account.apiKey),
    hasApiSecret: Boolean(account.apiSecret),
    hasToken: Boolean(account.token || account.accessToken),
    hasPosSecretKey: Boolean(account.posSecretKey),
    storeFrontCode: account.storeFrontCode,
    chainId: account.chainId,
    vendorId: account.vendorId,
    integrationReferenceCode: account.integrationReferenceCode,
    integrationRefCode: account.integrationRefCode || account.integrationReferenceCode,
    webhookAuthType: account.webhookAuthType,
    authType: account.authType || account.webhookAuthType,
    callbackUrl: account.callbackUrl || "",
    webhookId: account.webhookId,
    settings: account.settings,
    mode: account.settings?.platformMode || config.mode,
    testStrategy: account.settings?.testStrategy || config.testStrategy,
    requiredFields: config.requiredFields,
    optionalFields: config.optionalFields,
    active: account.active,
    lastSyncAt: account.lastSyncAt,
    pollingEnabled: Boolean(account.pollingEnabled),
    webhookEnabled: account.webhookEnabled !== false,
    lastWebhookAt: account.lastWebhookAt || null,
    lastPollAt: account.lastPollAt || account.lastSyncAt || null,
    lastError: account.lastError || "",
    connectionStatus: account.connectionStatus || HEALTH_STATUS.UNKNOWN,
    connectionHealth: buildHealthPayload(account),
    lastCheckAt: account.lastCheckAt || null,
    lastSuccessAt: account.lastSuccessAt || null,
    lastErrorAt: account.lastErrorAt || null,
    lastErrorCode: account.lastErrorCode || "",
    lastErrorMessage: account.lastErrorMessage || "",
    lastHttpStatus: account.lastHttpStatus ?? null,
    lastLatencyMs: account.lastLatencyMs ?? null,
    consecutiveFailures: account.consecutiveFailures || 0,
    lastCallbackAt: account.lastCallbackAt || null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };

  if (!includeSecrets) {
    return safeAccount;
  }

  return {
    ...safeAccount,
    hasApiPassword: Boolean(account.apiPassword),
    tokenExpiresAt: account.tokenExpiresAt,
    webhookUsername: account.webhookUsername,
    hasWebhookPassword: Boolean(account.webhookPassword),
    hasStaticToken: Boolean(account.staticToken),
    hasWebhookSecret: Boolean(account.webhookSecret),
    hasRefreshToken: Boolean(account.refreshToken),
    verificationStatus: account.verificationStatus,
    verificationNote: account.verificationNote,
    lastVerificationAt: account.lastVerificationAt,
    verifiedAt: account.verifiedAt,
    lastValidationMode: account.lastValidationMode,
    webhookSecret: account.webhookSecret || account.staticToken || "",
  };
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }

  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;)\s*delivera_session\s*=\s*([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]).trim();
  }

  return "";
}

function timingSafeStringEqual(left, right) {
  const leftValue = trimmed(left);
  const rightValue = trimmed(right);
  return Boolean(leftValue) &&
    leftValue.length === rightValue.length &&
    crypto.timingSafeEqual(Buffer.from(leftValue), Buffer.from(rightValue));
}

function setSessionCookie(res, token) {
  const secure = FORCE_HTTPS ? "; Secure" : "";
  const maxAge = Math.floor(REFRESH_TOKEN_MAX_AGE_MS / 1000);
  res.setHeader("Set-Cookie", `delivera_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = FORCE_HTTPS ? "; Secure" : "";
  res.setHeader("Set-Cookie", `delivera_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`);
}

function isSessionExpired(createdAt, maxAgeMs) {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) {
    return true;
  }

  return Date.now() - createdMs > maxAgeMs;
}

function sessionActorLookup(tableName) {
  if (tableName === "admin_sessions") {
    return { actorColumn: "admin_id", actorTable: "admins" };
  }
  if (tableName === "restaurant_sessions") {
    return { actorColumn: "restaurant_id", actorTable: "restaurants" };
  }
  if (tableName === "courier_sessions") {
    return { actorColumn: "courier_id", actorTable: "couriers" };
  }
  return null;
}

function isSessionActorValid(tableName, session) {
  const lookup = sessionActorLookup(tableName);
  if (!lookup || !session?.[lookup.actorColumn]) {
    return false;
  }
  return Boolean(db.prepare(`SELECT id FROM ${lookup.actorTable} WHERE id = ?`).get(session[lookup.actorColumn]));
}

function purgeSessionRecord(tableName, tokenColumn, token, cacheKey = "") {
  db.prepare(`DELETE FROM ${tableName} WHERE ${tokenColumn} = ?`).run(token);
  if (REDIS_URL && cacheKey) {
    redisSync.del(cacheKey);
  }
}

function getSessionByToken(tableName, tokenColumn, token, maxAgeMs) {
  if (!token) {
    return null;
  }

  const cacheKey = `delivera:session:${tableName}:${token}`;
  if (REDIS_URL) {
    const cached = redisSync.get(cacheKey);
    if (cached) {
      try {
        const session = JSON.parse(cached);
        if (!isSessionExpired(session.created_at, maxAgeMs) && isSessionActorValid(tableName, session)) {
          return session;
        }
        purgeSessionRecord(tableName, tokenColumn, token, cacheKey);
        return null;
      } catch (err) {
        // fallback
      }
    }
  }

  const session = db.prepare(`SELECT * FROM ${tableName} WHERE ${tokenColumn} = ?`).get(token) || null;
  if (!session) {
    return null;
  }

  if (isSessionExpired(session.created_at, maxAgeMs)) {
    purgeSessionRecord(tableName, tokenColumn, token, cacheKey);
    return null;
  }

  if (!isSessionActorValid(tableName, session)) {
    purgeSessionRecord(tableName, tokenColumn, token, cacheKey);
    return null;
  }

  if (REDIS_URL) {
    const ttlSeconds = Math.max(60, Math.floor(maxAgeMs / 1000));
    redisSync.set(cacheKey, JSON.stringify(session), ttlSeconds);
  }

  return session;
}

function getAdminSession(req) {
  return getSessionByToken("admin_sessions", "token", getBearerToken(req), ADMIN_SESSION_MAX_AGE_MS);
}

function getSessionFromQueryToken(req, role) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const token = trimmed(requestUrl.searchParams.get("token"));
  if (!token) {
    return null;
  }
  const config = sessionConfigByRole(role);
  return getSessionByToken(config.tableName, "token", token, config.maxAgeMs);
}

function adminActorId(session) {
  return session?.admin_id || null;
}

function sessionConfigByRole(actorRole) {
  if (actorRole === "admin") {
    return { tableName: "admin_sessions", actorColumn: "admin_id", maxAgeMs: ADMIN_SESSION_MAX_AGE_MS };
  }
  if (actorRole === "restaurant") {
    return { tableName: "restaurant_sessions", actorColumn: "restaurant_id", maxAgeMs: RESTAURANT_SESSION_MAX_AGE_MS };
  }
  if (actorRole === "courier") {
    return { tableName: "courier_sessions", actorColumn: "courier_id", maxAgeMs: COURIER_SESSION_MAX_AGE_MS };
  }

  throw httpError(400, "Desteklenmeyen oturum rolu.");
}

function revokeRefreshTokens(actorRole, actorId) {
  db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND actor_id = ?").run(actorRole, actorId);
}

function persistRefreshToken(actorRole, actorId, refreshToken, req) {
  const createdAt = new Date();
  const refreshMaxAgeMs = actorRole === "admin" ? ADMIN_REFRESH_TOKEN_MAX_AGE_MS : REFRESH_TOKEN_MAX_AGE_MS;
  const expiresAt = new Date(createdAt.getTime() + refreshMaxAgeMs);
  db.prepare(`
    INSERT INTO refresh_tokens (id, actor_role, actor_id, token_hash, ip_address, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uid("rft"),
    actorRole,
    actorId,
    hashOpaqueToken(refreshToken),
    clientIp(req),
    String(req.headers["user-agent"] || "").slice(0, 240),
    createdAt.toISOString(),
    expiresAt.toISOString()
  );

  return expiresAt.toISOString();
}

function platformOrderStatusForPackageStatus(status, fallback = "approved") {
  const normalized = normalizeStatus(status);
  if (normalized === DELIVERED_STATUS) return "completed";
  if ([CANCELED_STATUS, REJECTED_STATUS, FAILED_STATUS].includes(normalized)) return "cancelled";
  if ([ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(normalized)) return "assigned";
  return fallback;
}

function shouldApplyIncomingPlatformStatus(currentStatus, incomingStatus) {
  const current = normalizeStatus(currentStatus);
  const incoming = normalizeStatus(incomingStatus);
  if (current === incoming) return false;
  if ([DELIVERED_STATUS, CANCELED_STATUS, REJECTED_STATUS].includes(current)) return false;
  // Kurye kabul/yola cikis yerel teslimat akisi tarafindan yonetilir. Dis
  // platformdaki ara durum, kurye atamasini atlayarak paketi yolda yapamaz.
  if ([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(incoming)) return false;
  if ([DELIVERED_STATUS, CANCELED_STATUS, REJECTED_STATUS, FAILED_STATUS].includes(incoming)) return true;
  const rank = {
    [PENDING_APPROVAL_STATUS]: 0,
    [PENDING_STATUS]: 0,
    [PREPARING_STATUS]: 1,
    [AWAITING_ASSIGNMENT_STATUS]: 1,
    [ASSIGNED_STATUS]: 2,
    [ACCEPTED_BY_COURIER_STATUS]: 3,
    [ON_ROUTE_STATUS]: 4,
  };
  return Number(rank[incoming] ?? -1) > Number(rank[current] ?? -1);
}

function cleanupActorSessions(actorRole, actorId) {
  const sessionConfig = sessionConfigByRole(actorRole);
  const cutoff = new Date(Date.now() - sessionConfig.maxAgeMs).toISOString();
  const expiredSessions = db.prepare(`
    SELECT token FROM ${sessionConfig.tableName}
    WHERE ${sessionConfig.actorColumn} = ? AND created_at < ?
  `).all(actorId, cutoff);

  db.prepare(`
    DELETE FROM ${sessionConfig.tableName}
    WHERE ${sessionConfig.actorColumn} = ? AND created_at < ?
  `).run(actorId, cutoff);
  db.prepare(`
    DELETE FROM refresh_tokens
    WHERE actor_role = ? AND actor_id = ? AND expires_at <= ?
  `).run(actorRole, actorId, new Date().toISOString());

  if (REDIS_URL) {
    expiredSessions.forEach((session) => {
      redisSync.del(`delivera:session:${sessionConfig.tableName}:${session.token}`);
    });
  }
}

function issueSessionPair(actorRole, actorId, req) {
  const sessionConfig = sessionConfigByRole(actorRole);
  const token = createSessionToken();
  const refreshToken = createRefreshToken();
  const now = new Date().toISOString();

  if (actorRole === "admin" || actorRole === "restaurant") {
    cleanupActorSessions(actorRole, actorId);
  } else if (REDIS_URL) {
    try {
      const oldSessions = db.prepare(`SELECT token FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).all(actorId);
      oldSessions.forEach((s) => {
        redisSync.del(`delivera:session:${sessionConfig.tableName}:${s.token}`);
      });
    } catch (err) {}
  }

  if (actorRole === "courier") {
    db.prepare(`DELETE FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).run(actorId);
    revokeRefreshTokens(actorRole, actorId);
  }
  db.prepare(`INSERT INTO ${sessionConfig.tableName} (token, ${sessionConfig.actorColumn}, created_at) VALUES (?, ?, ?)`).run(
    token,
    actorId,
    now
  );
  const refreshExpiresAt = persistRefreshToken(actorRole, actorId, refreshToken, req);

  return {
    token,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + sessionConfig.maxAgeMs).toISOString(),
    refreshExpiresAt,
  };
}

function refreshSessionPair(actorRole, providedRefreshToken, req) {
  const tokenHash = hashOpaqueToken(providedRefreshToken);
  const refreshRow = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE actor_role = ? AND token_hash = ?
  `).get(actorRole, tokenHash);

  if (!refreshRow) {
    throw httpError(401, "Refresh token gecersiz.");
  }

  const expiresAtMs = new Date(refreshRow.expires_at).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
    throw httpError(401, "Refresh token suresi dolmus.");
  }

  const sessionConfig = sessionConfigByRole(actorRole);
  const lookup = sessionActorLookup(sessionConfig.tableName);
  const actorExists = lookup
    ? Boolean(db.prepare(`SELECT id FROM ${lookup.actorTable} WHERE id = ?`).get(refreshRow.actor_id))
    : false;
  if (!actorExists) {
    db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
    throw httpError(401, "Kayit bulunamadi, lutfen tekrar giris yapin.");
  }

  db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
  if (actorRole === "admin" || actorRole === "restaurant") {
    const currentAccessToken = getBearerToken(req);
    const currentSession = currentAccessToken
      ? db.prepare(`SELECT ${sessionConfig.actorColumn} AS actor_id FROM ${sessionConfig.tableName} WHERE token = ?`).get(currentAccessToken)
      : null;
    if (currentSession?.actor_id === refreshRow.actor_id) {
      revokeAccessToken(sessionConfig.tableName, currentAccessToken);
    }
  }
  return issueSessionPair(actorRole, refreshRow.actor_id, req);
}

function revokeAccessToken(tableName, token) {
  if (!token) {
    return;
  }

  db.prepare(`DELETE FROM ${tableName} WHERE token = ?`).run(token);
  if (REDIS_URL) {
    redisSync.del(`delivera:session:${tableName}:${token}`);
  }
}

function validateRefreshDraft(body) {
  const refreshToken = trimmed(body.refreshToken || body.refresh_token);
  if (!refreshToken) {
    throw validationError("refreshToken zorunludur.");
  }

  return { refreshToken };
}

function validatePasswordResetRequestDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  if (!username) {
    throw validationError("Kullanici adi zorunludur.");
  }

  return { username };
}

function validatePasswordResetDraft(body) {
  const token = trimmed(body.token);
  const password = String(body.password || "");
  if (!token || !password) {
    throw validationError("Reset token ve yeni sifre zorunludur.");
  }
  if (password.length < 8) {
    throw validationError("Yeni sifre en az 8 karakter olmali.");
  }

  return { token, password };
}

function actorLookupByRole(actorRole, username) {
  if (actorRole === "admin") {
    return db.prepare("SELECT * FROM admins WHERE username = ?").get(username) || null;
  }
  if (actorRole === "restaurant") {
    return db.prepare("SELECT * FROM restaurants WHERE username = ?").get(username) || null;
  }
  if (actorRole === "courier") {
    return db.prepare("SELECT * FROM couriers WHERE username = ?").get(username) || null;
  }

  return null;
}

function updateActorPassword(actorRole, actorId, password) {
  const passwordInfo = hashPassword(password);
  
  const tableMap = { "admin": "admins", "restaurant": "restaurants", "courier": "couriers" };
  const table = tableMap[actorRole];
  
  if (!table) {
    throw httpError(400, "Desteklenmeyen kullanici rolu.");
  }
  
  // 1. Revoke all refresh tokens
  revokeRefreshTokens(actorRole, actorId);
  
  const sessionConfig = sessionConfigByRole(actorRole);
  
  // 2. Delete all active sessions (access tokens)
  if (sessionConfig && sessionConfig.tableName) {
    if (REDIS_URL) {
      try {
        const oldSessions = db.prepare(`SELECT token FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).all(actorId);
        oldSessions.forEach((s) => {
          redisSync.del(`delivera:session:${sessionConfig.tableName}:${s.token}`);
        });
      } catch (err) {}
    }
    db.prepare(`DELETE FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).run(actorId);
  }
  
  // 3. Update password hash
  db.prepare(`UPDATE ${table} SET password_hash = ?, password_salt = ? WHERE id = ?`)
    .run(passwordInfo.hash, passwordInfo.salt, actorId);
}

function issuePasswordReset(actorRole, actorId, req) {
  const token = createPasswordResetToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + PASSWORD_RESET_MAX_AGE_MS);
  db.prepare(`
    INSERT INTO password_reset_tokens (id, actor_role, actor_id, token_hash, requested_ip, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    uid("prt"),
    actorRole,
    actorId,
    hashOpaqueToken(token),
    clientIp(req),
    createdAt.toISOString(),
    expiresAt.toISOString()
  );

  return token;
}

function consumePasswordReset(actorRole, token) {
  const tokenHash = hashOpaqueToken(token);
  const startTime = Date.now();
  
  const row = db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE actor_role = ? AND token_hash = ? AND used_at IS NULL
  `).get(actorRole, tokenHash);

  let isValid = false;
  let errorMsg = "Reset token gecersiz veya suresi dolmus.";

  if (row) {
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (!Number.isNaN(expiresAtMs) && expiresAtMs > Date.now()) {
      isValid = true;
    } else {
      db.prepare("DELETE FROM password_reset_tokens WHERE id = ?").run(row.id);
    }
  }

  if (!isValid) {
    // Timing attack mitigation: add random delay to normalize response time
    const elapsed = Date.now() - startTime;
    // Timing attack mitigation removed to prevent blocking or sync issues
    throw httpError(400, errorMsg);
  }

  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return row;
}

function logPasswordReset(actorRole, username, token) {
  if (!LOG_PASSWORD_RESET_TOKENS) {
    return;
  }
  const line = `[${new Date().toISOString()}] role=${actorRole} username=${username} token=${token}\n`;
  fs.appendFileSync(PASSWORD_RESET_LOG_FILE, line, "utf8");
}

function getAuditLogs(limit = 30, filter = {}) {
  const offset = parsePositiveInteger(filter.offset, 0);
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM audit_logs WHERE restaurant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(filter.restaurantId, limit, offset)
    : db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);

  return rows.map((row) => ({
    id: row.id,
    actorRole: row.actor_role,
    actorId: row.actor_id,
    action: row.action,
    packageId: row.package_id,
    restaurantId: row.restaurant_id,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
  }));
}

function writeAuditLog(entry) {
  db.prepare(`
    INSERT INTO audit_logs (actor_role, actor_id, action, package_id, restaurant_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.actorRole,
    entry.actorId || null,
    entry.action,
    entry.packageId || null,
    entry.restaurantId || null,
    json(entry.details || {}),
    new Date().toISOString()
  );
}

const PERSISTENCE_LOG_TABLES = new Set(["restaurants", "couriers", "packages", "platform_orders"]);

function logPersistenceEvent(eventName, details = {}) {
  const error = details.error || null;
  const payload = {
    table_name: details.tableName || details.table_name || "",
    inserted_id: details.insertedId || details.inserted_id || null,
    request_id: details.requestId || details.request_id || null,
    error_message: error ? error.message : (details.errorMessage || details.error_message || null),
  };

  if (error || payload.error_message) {
    logger.error(eventName, { ...payload, error });
    return;
  }

  logger.info(eventName, payload);
}

function compactLogSql(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim();
}

function affectedRowCount(result = {}) {
  return result.rowCount ?? result.changes ?? 0;
}

function traceCreateEndpoint(eventName, req, pathname, extra = {}) {
  logger.info(eventName, {
    requestId: req.requestId,
    method: req.method,
    path: pathname,
    dbClient: dbFacade.clientName(),
    ...extra,
  });
}

function runInsertWithTrace({ sql, params = [], tableName, insertedId, requestId }) {
  logger.info("BEFORE_INSERT", {
    requestId,
    tableName,
    insertedId,
    sql: compactLogSql(sql),
  });
  const result = db.prepare(sql).run(...params);
  logger.info("AFTER_INSERT", {
    requestId,
    tableName,
    insertedId,
    sql: compactLogSql(sql),
    rowCount: affectedRowCount(result),
  });
  return result;
}

function logAfterCommit(tableName, insertedId, requestId) {
  logger.info("AFTER_COMMIT", {
    requestId,
    tableName,
    insertedId,
  });
}

function selectInsertedRowOrThrow(tableName, insertedId, requestId) {
  const sql = `SELECT * FROM ${tableName} WHERE id = ?`;
  const row = db.prepare(sql).get(insertedId);
  logger.info("AFTER_SELECT", {
    requestId,
    tableName,
    insertedId,
    sql,
    rowCount: row ? 1 : 0,
  });
  if (!row) {
    const error = new Error(`${tableName} insert committed but verification SELECT returned empty for id ${insertedId}`);
    logPersistenceEvent(`${tableName}_select_after_commit_failed`, { tableName, insertedId, requestId, error });
    throw error;
  }
  return row;
}

function logInsertSkipped(tableName, reason, req, extra = {}) {
  logger.warn("INSERT_SKIPPED", {
    requestId: req?.requestId || null,
    tableName,
    reason,
    ...extra,
  });
}

function maskRestaurantCreateBody(body = {}) {
  const masked = { ...body };
  for (const key of ["password", "portalPassword"]) {
    if (masked[key]) {
      masked[key] = "***";
    }
  }
  return masked;
}

function assertPersistedRecord(tableName, insertedId, eventName, requestId = null) {
  if (!PERSISTENCE_LOG_TABLES.has(tableName)) {
    throw new Error(`Unsupported persistence table: ${tableName}`);
  }

  const row = db.prepare(`SELECT id FROM ${tableName} WHERE id = ?`).get(insertedId);
  if (!row) {
    const error = new Error(`${tableName} insert verification failed for id ${insertedId}`);
    logPersistenceEvent(eventName, { tableName, insertedId, requestId, error });
    throw error;
  }

  logPersistenceEvent(eventName, { tableName, insertedId, requestId });
  return row;
}

function shouldPersistNotification(event) {
  return Boolean(event?.message) && !["courier-location"].includes(event.type || "");
}

function persistNotification(targetRole, targetId, event) {
  db.prepare(`
    INSERT INTO notification_logs (id, target_role, target_id, event_type, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uid("ntf"),
    targetRole,
    targetId || null,
    event.type || "workspace-update",
    event.message,
    nowIso()
  );
}

function persistNotificationsForEvent(event) {
  if (!shouldPersistNotification(event)) {
    return;
  }
  persistNotification("admin", null, event);
  if (event.restaurantId && !shouldSuppressRestaurantAlert(event)) {
    persistNotification("restaurant", event.restaurantId, event);
  }
  if (event.courierId) {
    persistNotification("courier", event.courierId, event);
  }
}

function getNotifications(targetRole, targetId = null, limit = 20) {
  const offset = 0;
  const rows = targetId
    ? db.prepare(`
      SELECT * FROM notification_logs
      WHERE target_role = ? AND target_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ? OFFSET ?
    `).all(targetRole, targetId, limit, offset)
    : db.prepare(`
      SELECT * FROM notification_logs
      WHERE target_role = ? AND target_id IS NULL
      ORDER BY datetime(created_at) DESC
      LIMIT ? OFFSET ?
    `).all(targetRole, limit, offset);

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    message: row.message,
    createdAt: row.created_at,
  }));
}

function getAnnouncements(targetRole = null) {
  const rows = targetRole
    ? db.prepare(`
      SELECT * FROM announcements
      WHERE active = 1 AND target_role = ?
      ORDER BY datetime(updated_at) DESC
    `).all(targetRole)
    : db.prepare(`
      SELECT * FROM announcements
      WHERE active = 1
      ORDER BY datetime(updated_at) DESC
    `).all();

  return rows.map((row) => ({
    id: row.id,
    targetRole: row.target_role,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function shouldSuppressRestaurantAlert(event = {}) {
  const source = trimmed(event.source).toLowerCase();
  return event.suppressRestaurantAlert === true || [
    "manual",
    "external_manual",
    "platform_manual",
    "restaurant_panel",
  ].includes(source);
}

function getAnnouncementById(announcementId) {
  return getAnnouncements().find((announcement) => announcement.id === announcementId) || null;
}

function createAnnouncement(targetRole, title, message) {
  const stamp = nowIso();
  const id = uid("announce");
  db.prepare(`
    INSERT INTO announcements (id, target_role, title, message, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, targetRole, title, message, stamp, stamp);
  return id;
}

function deactivateAnnouncement(announcementId) {
  const result = db.prepare(`
    UPDATE announcements
    SET active = 0, updated_at = ?
    WHERE id = ? AND active = 1
  `).run(nowIso(), announcementId);
  return result.changes > 0;
}

function clearAnnouncements(targetRole = "courier") {
  db.prepare(`
    UPDATE announcements
    SET active = 0, updated_at = ?
    WHERE target_role = ? AND active = 1
  `).run(nowIso(), targetRole);
}

function getPlatformAccounts(filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM platform_accounts WHERE restaurant_id = ? ORDER BY datetime(updated_at) DESC").all(filter.restaurantId)
    : db.prepare("SELECT * FROM platform_accounts ORDER BY datetime(updated_at) DESC").all();

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurant_id,
    platform: row.platform,
    externalId: row.external_id || row.external_store_id,
    externalStoreId: row.external_store_id,
    externalMerchantId: row.external_merchant_id,
    apiUsername: row.api_username,
    apiPassword: row.api_password,
    apiKey: row.api_key,
    apiSecret: row.api_secret,
    token: row.token || row.access_token,
    accessToken: row.access_token || row.token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    callbackUrl: row.callback_url,
    integrationReferenceCode: row.integration_ref_code || row.integration_reference_code || "",
    integrationRefCode: row.integration_ref_code || row.integration_reference_code || "",
    posSecretKey: row.pos_secret_key || "",
    authType: row.auth_type || row.webhook_auth_type,
    storeFrontCode: row.store_front_code,
    chainId: row.chain_id,
    vendorId: row.vendor_id,
    webhookAuthType: row.webhook_auth_type,
    webhookApiKey: row.webhook_api_key,
    webhookUsername: row.webhook_username,
    webhookPassword: row.webhook_password,
    staticToken: row.static_token,
    webhookSecret: row.webhook_secret || row.static_token,
    webhookId: row.webhook_id,
    settings: parseJson(row.settings_json, {}),
    verificationStatus: row.verification_status || PLATFORM_VERIFICATION_STATUS.PENDING,
    verificationNote: row.verification_note || "",
    lastVerificationAt: row.last_verification_at,
    verifiedAt: row.verified_at,
    lastValidationMode: row.last_validation_mode,
    active: row.is_active === null || row.is_active === undefined ? Boolean(row.active) : Boolean(row.is_active),
    lastSyncAt: row.last_sync_at || null,
    pollingEnabled: Boolean(row.polling_enabled),
    webhookEnabled: row.webhook_enabled === null || row.webhook_enabled === undefined ? true : Boolean(row.webhook_enabled),
    lastWebhookAt: row.last_webhook_at || null,
    lastPollAt: row.last_poll_at || row.last_sync_at || null,
    lastError: row.last_error || "",
    connectionStatus: row.connection_status || HEALTH_STATUS.UNKNOWN,
    lastCheckAt: row.last_check_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorAt: row.last_error_at || null,
    lastErrorCode: row.last_error_code || "",
    lastErrorMessage: row.last_error_message || "",
    lastHttpStatus: row.last_http_status ?? null,
    lastLatencyMs: row.last_latency_ms ?? null,
    consecutiveFailures: row.consecutive_failures || 0,
    lastCallbackAt: row.last_callback_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getPlatformOrders(filter = {}) {
  const pagination = filter.pagination || null;
  const limit = pagination ? clampLimit(pagination.limit) : 100;
  const offset = pagination ? parsePositiveInteger(pagination.offset) : 0;
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM platform_orders WHERE restaurant_id = ? ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?").all(filter.restaurantId, limit, offset)
    : db.prepare("SELECT * FROM platform_orders ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?").all(limit, offset);

  return rows.map(mapPlatformOrder);
}

function mapPlatformOrder(row) {
  return {
    id: row.id,
    platform: row.platform,
    platformOrderId: row.platform_order_id,
    platformRestaurantId: row.platform_restaurant_id || "",
    posentegraId: row.posentegra_id || "",
    restaurantId: row.restaurant_id,
    packageId: row.package_id || "",
    customerName: row.customer_name,
    phone: row.phone,
    address: row.address,
    totalPrice: Number(row.total_price || 0),
    note: row.note || "",
    status: row.status,
    rawPayload: parseJson(row.raw_payload, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getPlatformOrderForPackageRow(row) {
  if (!row) {
    return null;
  }
  const platformOrder = db.prepare(`
    SELECT *
    FROM platform_orders
    WHERE package_id = ?
       OR (restaurant_id = ? AND platform_order_id = ?)
       OR (posentegra_id IS NOT NULL AND posentegra_id != '' AND posentegra_id = ?)
    ORDER BY datetime(updated_at) DESC
    LIMIT 1
  `).get(row.id, row.restaurant_id, row.external_order_id || row.external_order_no || "", row.posentegra_id || "");
  return platformOrder ? mapPlatformOrder(platformOrder) : null;
}

function buildPlatformOrderLookup(packageRows = []) {
  const rows = (packageRows || []).filter(Boolean);
  if (!rows.length) {
    return () => null;
  }

  const packageIds = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  const orderIds = [...new Set(rows.map((row) => row.external_order_id || row.external_order_no || "").filter(Boolean))];
  const posentegraIds = [...new Set(rows.map((row) => row.posentegra_id || "").filter(Boolean))];
  const where = [];
  const params = [];

  if (packageIds.length) {
    where.push(`package_id IN (${packageIds.map(() => "?").join(",")})`);
    params.push(...packageIds);
  }
  if (orderIds.length) {
    where.push(`platform_order_id IN (${orderIds.map(() => "?").join(",")})`);
    params.push(...orderIds);
  }
  if (posentegraIds.length) {
    where.push(`posentegra_id IN (${posentegraIds.map(() => "?").join(",")})`);
    params.push(...posentegraIds);
  }

  if (!where.length) {
    return () => null;
  }

  const candidates = db.prepare(`
    SELECT *
    FROM platform_orders
    WHERE ${where.join(" OR ")}
    ORDER BY datetime(updated_at) DESC
  `).all(...params);

  return (row) => {
    const externalOrderId = row.external_order_id || row.external_order_no || "";
    const posentegraId = row.posentegra_id || "";
    const match = candidates.find((candidate) =>
      candidate.package_id === row.id ||
      (candidate.restaurant_id === row.restaurant_id && candidate.platform_order_id === externalOrderId) ||
      (posentegraId && candidate.posentegra_id === posentegraId)
    );
    return match ? mapPlatformOrder(match) : null;
  };
}

function platformOrdersPagination(filter = {}, pagination = { limit: DEFAULT_PAGE_LIMIT, offset: 0 }) {
  const total = filter.restaurantId
    ? countTable("platform_orders", "restaurant_id = ?", [filter.restaurantId])
    : countTable("platform_orders");
  return pageMeta(total, pagination);
}

function getPlatformOrderById(id) {
  const row = db.prepare("SELECT * FROM platform_orders WHERE id = ?").get(id);
  return row ? mapPlatformOrder(row) : null;
}

function updatePlatformOrderPackageId(platformOrderId, packageId, requestId = null) {
  if (!platformOrderId || !packageId) {
    return;
  }
  const sql = "UPDATE platform_orders SET package_id = ?, updated_at = ? WHERE id = ?";
  const result = db.prepare(sql).run(packageId, nowIso(), platformOrderId);
  logger.info("platform_order_package_linked", {
    requestId,
    platform_order_id: platformOrderId,
    package_id: packageId,
    sql,
    rowCount: affectedRowCount(result),
  });
}

function restaurantsPagination(filter = {}, pagination = { limit: DEFAULT_PAGE_LIMIT, offset: 0 }) {
  const total = filter.restaurantId ? countTable("restaurants", "id = ?", [filter.restaurantId]) : countTable("restaurants");
  return pageMeta(total, pagination);
}

function couriersPagination(pagination = { limit: DEFAULT_PAGE_LIMIT, offset: 0 }) {
  return pageMeta(countTable("couriers"), pagination);
}

function normalizePlatformOrderStatus(status) {
  const normalized = trimmed(status) || "pending_approval";
  return PLATFORM_ORDER_STATUSES.has(normalized) ? normalized : "pending_approval";
}

function upsertPlatformOrderRecord(order, restaurantId, status = "pending_approval", options = {}) {
  const platform = normalizePlatformInput(order.platform) || order.platform;
  const platformOrderId = trimmed(order.orderId || order.platformOrderId || order.externalOrderNo);
  const platformRestaurantId = trimmed(order.platformRestaurantId || order.platform_restaurant_id || order.externalStoreId || order.externalRestaurantId || options.platformRestaurantId);
  const posentegraId = trimmed(order.posentegraId || order.posentegra_id || order.pid || options.posentegraId);
  const packageId = trimmed(order.packageId || order.package_id || options.packageId);
  if (!platform || !platformOrderId || !restaurantId) {
    logger.warn("INSERT_SKIPPED", {
      requestId: options.requestId || null,
      tableName: "platform_orders",
      reason: "missing_platform_order_identity",
      platform,
      platformOrderId,
      platformRestaurantId,
      restaurantId,
    });
    return null;
  }

  const stamp = nowIso();
  const existing = db.prepare(`
    SELECT id FROM platform_orders
    WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
  `).get(platform, platformOrderId, restaurantId);

  if (existing) {
    db.prepare(`
      UPDATE platform_orders
      SET platform_restaurant_id = COALESCE(NULLIF(?, ''), platform_restaurant_id),
          posentegra_id = COALESCE(NULLIF(?, ''), posentegra_id),
          package_id = COALESCE(NULLIF(?, ''), package_id),
          customer_name = ?, phone = ?, address = ?, total_price = ?, note = ?, status = ?, raw_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(
      platformRestaurantId,
      posentegraId,
      packageId,
      trimmed(order.customerName) || "Musteri",
      trimmed(order.phone) || "Gizli Numara",
      trimmed(order.address || order.customerAddress) || "Adres yok",
      normalizeMoney(order.totalPrice ?? order.orderAmount),
      trimmed(order.customerNote || order.note),
      normalizePlatformOrderStatus(status),
      json(order.rawPayload || order),
      stamp,
      existing.id
    );
    return existing.id;
  }

  const id = uid("po");
  const insertSql = `
    INSERT INTO platform_orders (
      id, platform, platform_order_id, platform_restaurant_id, posentegra_id, restaurant_id, package_id, customer_name, phone, address, total_price, note, status, raw_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const insertParams = [
    id,
    platform,
    platformOrderId,
    platformRestaurantId || null,
    posentegraId || null,
    restaurantId,
    packageId || null,
    trimmed(order.customerName) || "Musteri",
    trimmed(order.phone) || "Gizli Numara",
    trimmed(order.address || order.customerAddress) || "Adres yok",
    normalizeMoney(order.totalPrice ?? order.orderAmount),
    trimmed(order.customerNote || order.note),
    normalizePlatformOrderStatus(status),
    json(order.rawPayload || order),
    stamp,
    stamp,
  ];
  runInsertWithTrace({
    sql: insertSql,
    params: insertParams,
    tableName: "platform_orders",
    insertedId: id,
    requestId: options.requestId || null,
  });
  assertPersistedRecord("platform_orders", id, "platform_order_created", options.requestId || null);
  return id;
}

function updatePlatformOrderStatus(platform, platformOrderId, restaurantId, status) {
  if (!platform || !platformOrderId || !restaurantId) {
    return;
  }
  db.prepare(`
    UPDATE platform_orders
    SET status = ?, updated_at = ?
    WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
  `).run(normalizePlatformOrderStatus(status), nowIso(), platform, platformOrderId, restaurantId);
}

function updatePlatformOrderStatusByPackage(pkg, status) {
  if (!isPlatformBackedPackage(pkg)) {
    return;
  }
  updatePlatformOrderStatus(
    pkg?.source_platform || pkg?.sourcePlatform,
    pkg?.external_order_id || pkg?.externalOrderId || pkg?.external_order_no || pkg?.externalOrderNo,
    pkg?.restaurant_id || pkg?.restaurantId,
    status
  );
}

function isPlatformBackedPackage(pkg) {
  const source = normalizeOrderSource(pkg?.source, pkg?.source_platform || pkg?.sourcePlatform);
  return ["platform_webhook", "platform_api", "platform_polling"].includes(source);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      raw += chunk.toString();
      if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        raw = "";
        reject(httpError(413, "Payload cok buyuk."));
      }
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (!raw) {
        resolve({ raw: "", json: {} });
        return;
      }

      try {
        resolve({ raw, json: JSON.parse(raw) });
      } catch {
        reject(validationError("Gecersiz JSON gonderildi."));
      }
    });

    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function getSystemSettings() {
  const row = db.prepare("SELECT settings_json FROM system_settings WHERE id = 'main'").get();
  return row ? parseJson(row.settings_json, {}) : {};
}

function updateSystemSettings(newSettings) {
  const current = getSystemSettings();
  const merged = { ...current, ...newSettings };
  db.prepare(`
    INSERT INTO system_settings (id, settings_json) VALUES ('main', ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json
  `).run(json(merged));
  return merged;
}

let courierPushVapidKeys = null;

function ensureCourierPushConfigured() {
  if (courierPushVapidKeys) {
    return courierPushVapidKeys;
  }

  const row = db.prepare("SELECT settings_json FROM system_settings WHERE id = ?").get(WEB_PUSH_SETTINGS_ID);
  let keys = parseJson(row?.settings_json, {});
  if (!keys.publicKey || !keys.privateKey) {
    const generatedKeys = webPush.generateVAPIDKeys();
    db.prepare(`
      INSERT INTO system_settings (id, settings_json) VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(WEB_PUSH_SETTINGS_ID, json(generatedKeys));
    keys = parseJson(
      db.prepare("SELECT settings_json FROM system_settings WHERE id = ?").get(WEB_PUSH_SETTINGS_ID)?.settings_json,
      generatedKeys
    );
  }

  webPush.setVapidDetails(WEB_PUSH_SUBJECT, keys.publicKey, keys.privateKey);
  courierPushVapidKeys = keys;
  return courierPushVapidKeys;
}

function normalizePushSubscription(value = {}) {
  const endpoint = trimmed(value.endpoint);
  const p256dh = trimmed(value.keys?.p256dh);
  const auth = trimmed(value.keys?.auth);
  if (!endpoint.startsWith("https://") || endpoint.length > 4096 || !p256dh || !auth) {
    throw validationError("Gecersiz bildirim aboneligi.");
  }
  return {
    endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

function saveCourierPushSubscription(courierId, subscription) {
  const normalized = normalizePushSubscription(subscription);
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO courier_push_subscriptions (
      id, courier_id, endpoint, subscription_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      courier_id = excluded.courier_id,
      subscription_json = excluded.subscription_json,
      updated_at = excluded.updated_at
  `).run(uid("push"), courierId, normalized.endpoint, json(normalized), stamp, stamp);
  return normalized.endpoint;
}

function deleteCourierPushSubscription(courierId, endpoint) {
  if (!endpoint) return;
  db.prepare("DELETE FROM courier_push_subscriptions WHERE courier_id = ? AND endpoint = ?")
    .run(courierId, trimmed(endpoint));
}

function saveRestaurantPushSubscription(restaurantId, subscription) {
  const normalized = normalizePushSubscription(subscription);
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO restaurant_push_subscriptions (
      id, restaurant_id, endpoint, subscription_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      restaurant_id = excluded.restaurant_id,
      subscription_json = excluded.subscription_json,
      updated_at = excluded.updated_at
  `).run(uid("push"), restaurantId, normalized.endpoint, json(normalized), stamp, stamp);
  return normalized.endpoint;
}

function deleteRestaurantPushSubscription(restaurantId, endpoint) {
  if (!endpoint) return;
  db.prepare("DELETE FROM restaurant_push_subscriptions WHERE restaurant_id = ? AND endpoint = ?")
    .run(restaurantId, trimmed(endpoint));
}

function courierPushPayload(event) {
  const pkg = event.packageId ? getPackageById(event.packageId) : null;
  const trackingNo = pkg?.trackingNo || pkg?.externalOrderNo || event.packageId || "Yeni paket";
  const restaurantName = pkg?.restaurantName || "RESTOMAP";
  const address = pkg?.deliveryAddress || pkg?.address || pkg?.customerAddress || "Paket detaylarini acmak icin dokunun.";
  const packageId = pkg?.id || event.packageId || "";
  return {
    title: `Yeni Paket - ${trackingNo}`,
    body: `${restaurantName} - ${address}`,
    packageId,
    tag: packageId ? `delivera-package-${packageId}` : `delivera-courier-${event.courierId}`,
    url: packageId ? `/courier.html?package=${encodeURIComponent(packageId)}` : "/courier.html",
  };
}

function claimWebPush(key) {
  const now = Date.now();
  for (const [existingKey, sentAt] of recentWebPushes) {
    if (now - sentAt > WEB_PUSH_DEDUPE_MS) recentWebPushes.delete(existingKey);
  }
  if (recentWebPushes.has(key)) return false;
  recentWebPushes.set(key, now);
  return true;
}

function dispatchCourierPush(event) {
  if (!event?.courierId || !COURIER_PUSH_EVENT_TYPES.has(event.type)) {
    return;
  }
  const pushKey = `courier:${event.courierId}:${event.packageId || "general"}`;
  if (!claimWebPush(pushKey)) return;

  let subscriptions = [];
  try {
    ensureCourierPushConfigured();
    subscriptions = db.prepare(`
      SELECT endpoint, subscription_json
      FROM courier_push_subscriptions
      WHERE courier_id = ?
    `).all(event.courierId);
  } catch (error) {
    logger.warn("Courier push preparation failed", { courierId: event.courierId, error });
    return;
  }

  const payload = JSON.stringify(courierPushPayload(event));
  subscriptions.forEach((row) => {
    try {
      const request = webPush.sendNotification(parseJson(row.subscription_json, {}), payload, {
        TTL: 300,
        urgency: "high",
      });
      Promise.resolve(request).catch((error) => {
        if ([404, 410].includes(Number(error?.statusCode))) {
          db.prepare("DELETE FROM courier_push_subscriptions WHERE endpoint = ?").run(row.endpoint);
          return;
        }
        logger.warn("Courier push delivery failed", {
          courierId: event.courierId,
          packageId: event.packageId || null,
          statusCode: error?.statusCode || null,
          error,
        });
      });
    } catch (error) {
      logger.warn("Courier push request failed", {
        courierId: event.courierId,
        packageId: event.packageId || null,
        error,
      });
    }
  });
}

function restaurantPushPayload(event) {
  const packageId = event.packageId || event.orderId || "";
  const pkg = packageId ? getPackageById(packageId) : null;
  if (event.type === "restaurant-push-test") {
    return {
      title: "RESTOMAP Bildirim Testi",
      body: "Bildirimler acik. Yeni siparisler bu cihaza bildirilecek.",
      packageId: "",
      tag: `delivera-restaurant-test-${event.restaurantId}`,
      url: "/restaurant.html",
    };
  }
  const trackingNo = pkg?.trackingNo || pkg?.externalOrderNo || packageId || "Yeni siparis";
  const platform = pkg?.sourcePlatform || event.platform || "RESTOMAP";
  const customer = pkg?.recipient || event.customerName || "Yeni musteri siparisi";
  return {
    title: `Yeni Siparis - ${trackingNo}`,
    body: `${platform} - ${customer}. Siparisi acmak icin dokunun.`,
    packageId,
    tag: packageId ? `delivera-restaurant-package-${packageId}` : `delivera-restaurant-${event.restaurantId}`,
    url: packageId ? `/restaurant.html?package=${encodeURIComponent(packageId)}` : "/restaurant.html",
  };
}

function dispatchRestaurantPush(event) {
  if (!event?.restaurantId || !RESTAURANT_PUSH_EVENT_TYPES.has(event.type) || shouldSuppressRestaurantAlert(event)) {
    return;
  }
  const packageId = event.packageId || event.orderId;
  const pushKey = packageId ? `restaurant:${event.restaurantId}:${packageId}` : "";
  if (event.type !== "restaurant-push-test" && pushKey && !claimWebPush(pushKey)) return;

  let subscriptions = [];
  try {
    ensureCourierPushConfigured();
    subscriptions = db.prepare(`
      SELECT endpoint, subscription_json
      FROM restaurant_push_subscriptions
      WHERE restaurant_id = ?
    `).all(event.restaurantId);
  } catch (error) {
    logger.warn("Restaurant push preparation failed", { restaurantId: event.restaurantId, error });
    return;
  }

  const payload = JSON.stringify(restaurantPushPayload(event));
  subscriptions.forEach((row) => {
    try {
      const request = webPush.sendNotification(parseJson(row.subscription_json, {}), payload, {
        TTL: 300,
        urgency: "high",
      });
      Promise.resolve(request).catch((error) => {
        if ([404, 410].includes(Number(error?.statusCode))) {
          db.prepare("DELETE FROM restaurant_push_subscriptions WHERE endpoint = ?").run(row.endpoint);
          return;
        }
        logger.warn("Restaurant push delivery failed", {
          restaurantId: event.restaurantId,
          packageId: event.packageId || event.orderId || null,
          statusCode: error?.statusCode || null,
          error,
        });
      });
    } catch (error) {
      logger.warn("Restaurant push request failed", {
        restaurantId: event.restaurantId,
        packageId: event.packageId || event.orderId || null,
        error,
      });
    }
  });
}

function sendJson(res, statusCode, payload) {
  writeSecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  const requestId = res._deliveraRequestId || "";
  const responsePayload = payload && typeof payload === "object" && !Array.isArray(payload) && requestId && payload.requestId === undefined
    ? { ...payload, requestId }
    : payload;
  res.end(JSON.stringify(responsePayload));
}

function sendWebhookPosTicket(res, posTicket, payload = {}) {
  sendJson(res, 200, { ...payload, pos_ticket: String(posTicket || "") });
}

function sendText(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  writeSecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
}

function createLiveStream(audience) {
  const id = uid("stream");
  const stream = {
    id,
    audience,
    res: null,
    heartbeatId: null,
  };
  liveStreams.set(id, stream);
  return stream;
}

function closeLiveStream(streamId) {
  const stream = liveStreams.get(streamId);
  if (!stream) {
    return;
  }
  if (stream.heartbeatId) {
    clearInterval(stream.heartbeatId);
  }
  liveStreams.delete(streamId);
}

function streamMatchesAudience(stream, event) {
  if (stream.audience.role === "admin") {
    return true;
  }
  if (stream.audience.role === "restaurant") {
    return !event.restaurantId || event.restaurantId === stream.audience.restaurantId;
  }
  if (stream.audience.role === "courier") {
    return !event.courierId || event.courierId === stream.audience.courierId;
  }
  return false;
}

function broadcastLiveEvent(event) {
  persistNotificationsForEvent(event);
  const payload = `event: ${event.type || "workspace-update"}\ndata: ${JSON.stringify({
    ...event,
    type: event.type || "workspace-update",
    restaurantId: event.restaurantId || null,
    courierId: event.courierId || null,
    message: event.message || "",
    createdAt: nowIso(),
  })}\n\n`;

  liveStreams.forEach((stream) => {
    if (!stream.res || !streamMatchesAudience(stream, event)) {
      return;
    }
    try {
      stream.res.write(payload);
    } catch {
      closeLiveStream(stream.id);
    }
  });
  dispatchCourierPush(event);
  dispatchRestaurantPush(event);
}

function openLiveStream(req, res, audience) {
  const stream = createLiveStream(audience);
  writeSecurityHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  stream.res = res;
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, createdAt: nowIso() })}\n\n`);
  stream.heartbeatId = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ createdAt: nowIso() })}\n\n`);
    } catch {
      closeLiveStream(stream.id);
    }
  }, LIVE_STREAM_HEARTBEAT_MS);
  req.on("close", () => closeLiveStream(stream.id));
}

function sendFile(res, fileName) {
  const normalizedName = String(fileName || "").replace(/^[/\\]+/, "");
  const filePath = path.resolve(__dirname, normalizedName);
  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { error: "Gecersiz dosya yolu." });
    return;
  }

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Dosya bulunamadi." });
    return;
  }

  const ext = path.extname(normalizedName);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon",
  };

  writeSecurityHeaders(res);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (ext === ".cmd") {
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  res.writeHead(200, { "Content-Type": ext === ".cmd" ? "application/octet-stream" : (typeMap[ext] || "text/plain; charset=utf-8") });
  fs.createReadStream(filePath).pipe(res);
}

function recordRequestMetrics(startedAt, statusCode) {
  const elapsed = Date.now() - startedAt;
  performanceMetrics.requestCount += 1;
  performanceMetrics.totalResponseTimeMs += elapsed;
  performanceMetrics.maxResponseTimeMs = Math.max(performanceMetrics.maxResponseTimeMs, elapsed);
  performanceMetrics.statusBuckets[statusCode] = (performanceMetrics.statusBuckets[statusCode] || 0) + 1;
  if (statusCode >= 500) {
    performanceMetrics.errorCount += 1;
  }
  performanceMetrics.recentResponseTimes.push(elapsed);
  if (performanceMetrics.recentResponseTimes.length > 500) {
    performanceMetrics.recentResponseTimes.shift();
  }
}

function recordRequestLog(req, res, startedAt) {
  const statusCode = res.statusCode || 0;
  const elapsedMs = Date.now() - startedAt;
  const entry = {
    requestId: res._deliveraRequestId || "",
    method: req.method,
    path: (() => {
      try {
        return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
      } catch {
        return req.url || "";
      }
    })(),
    statusCode,
    elapsedMs,
    ip: clientIp(req),
    createdAt: nowIso(),
  };
  recentRequestLogs.push(entry);
  if (recentRequestLogs.length > 50) {
    recentRequestLogs.shift();
  }
  if (statusCode >= 500) {
    logger.error("Request failed", {
      ...entry,
      endpoint: entry.path,
      requestId: entry.requestId,
    });
  } else if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    logger.warn("Request completed with client error", {
      endpoint: entry.path,
      method: entry.method,
      requestId: entry.requestId,
      statusCode,
      elapsedMs,
    });
  }
}

function countTable(tableName, where = "", params = []) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}${where ? ` WHERE ${where}` : ""}`).get(...params).count;
}

function clampLimit(value, fallback = DEFAULT_PAGE_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(parsed)));
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function paginationFromRequest(req, defaults = {}) {
  let searchParams = new URLSearchParams();
  try {
    searchParams = new URL(req?.url || "/", `http://${req?.headers?.host || "localhost"}`).searchParams;
  } catch {}
  const limit = clampLimit(searchParams.get("limit") ?? defaults.limit, defaults.limit || DEFAULT_PAGE_LIMIT);
  const offset = parsePositiveInteger(searchParams.get("offset") ?? searchParams.get("cursor") ?? defaults.offset, defaults.offset || 0);
  return { limit, offset };
}

function pageMeta(total, pagination) {
  const offset = parsePositiveInteger(pagination?.offset, 0);
  const limit = clampLimit(pagination?.limit, DEFAULT_PAGE_LIMIT);
  const nextOffset = offset + limit;
  return {
    limit,
    offset,
    cursor: String(offset),
    nextCursor: nextOffset < total ? String(nextOffset) : null,
    hasMore: nextOffset < total,
    total,
  };
}

function databaseSizeBytes() {
  if (dbFacade.clientName() === "postgres") {
    try {
      return Number(db.prepare("SELECT pg_database_size(current_database()) AS size").get()?.size || 0);
    } catch {
      return 0;
    }
  }
  try {
    return fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0;
  } catch {
    return 0;
  }
}

function tableCountSafe(tableName, where = "", params = []) {
  try {
    return countTable(tableName, where, params);
  } catch {
    return 0;
  }
}

function queueHealthPayload() {
  return {
    assignmentRetryTimers: assignmentRetryTimers.size,
    assignmentSweepRunning,
    assignmentSweepQueued,
    platformPollingEnabled: PLATFORM_POLLING_ENABLED,
    platformPollIntervalMs: PLATFORM_POLL_INTERVAL_MS,
    liveStreams: liveStreams.size,
    queueService: queueService.health(),
    posentegraOutbox: posentegraOutbox.health(),
  };
}

function cacheHealthPayload() {
  const rateLimitHealth = rateLimitStore.health();
  return {
    mode: rateLimitHealth.mode,
    redisUrlConfigured: Boolean(REDIS_URL),
    rateLimitStore: rateLimitHealth,
    sessionRevocation: sessionRevocationService.health(),
    responseCache: "not_enabled",
  };
}

function platformHealthSummaryPayload() {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT COALESCE(connection_status, 'unknown') AS status, COUNT(*) AS count
    FROM platform_accounts
    GROUP BY COALESCE(connection_status, 'unknown')
  `).all();
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = row.count;
    return acc;
  }, {});
  return {
    total: tableCountSafe("platform_accounts"),
    connected: counts.connected || 0,
    warning: counts.warning || 0,
    error: counts.error || 0,
    disabled: counts.disabled || 0,
    unknown: counts.unknown || 0,
    webhookErrorsLast24h: tableCountSafe("platform_events", "event_type = ? AND status = ? AND created_at >= ?", ["webhook", "error", last24h]),
    callbackErrorsLast24h: tableCountSafe("platform_events", "event_type = ? AND status = ? AND created_at >= ?", ["callback", "error", last24h]),
    lastCheckedAt: db.prepare("SELECT MAX(last_check_at) AS value FROM platform_accounts").get()?.value || null,
  };
}

function systemStatusPayload() {
  const activeStatuses = [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS];
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dbOk = Boolean(db.prepare("SELECT 1 AS ok").get()?.ok);
  const dbEnv = dbFacade.databaseEnvInfo();

  return {
    ok: true,
    app: "RESTOMAP",
    env: NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      ok: dbOk,
      mode: dbFacade.clientName(),
      file: dbFacade.clientName() === "postgres" ? null : DB_FILE,
      sizeBytes: databaseSizeBytes(),
      postgresUrlConfigured: dbEnv.configured,
      postgresEnvName: dbEnv.variable,
      postgresUrlSource: dbEnv.source,
      postgresRequired: dbEnv.postgresRequired,
      renderDetected: dbEnv.renderDetected,
      skipReason: dbEnv.skipReason,
      pool: dbFacade.poolStatus(),
    },
    migrations: {
      database: migrationSummary.database,
      applied: migrationSummary.applied || [],
      skipped: migrationSummary.skipped || [],
      totalKnown: migrationSummary.totalKnown,
      checkedAt: migrationSummary.finishedAt,
    },
    uploads: {
      path: uploadsDir,
      persistentStorageRecommended: IS_PRODUCTION,
      note: IS_PRODUCTION ? "Render deploy/restart icin DELIVERA_UPLOAD_DIR kalici disk veya harici storage uzerinde olmali." : "",
    },
    totals: {
      restaurants: tableCountSafe("restaurants"),
      couriers: tableCountSafe("couriers"),
      packages: tableCountSafe("packages"),
      activePackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE status IN (${activeStatuses.map(() => "?").join(",")})`).get(...activeStatuses).count,
      packagesLast24h: tableCountSafe("packages", "created_at >= ?", [last24h]),
      platformOrders: tableCountSafe("platform_orders"),
      failedWebhooks: tableCountSafe("webhook_logs", "(response_status >= 400 OR dead_lettered_at IS NOT NULL)"),
      deadLetteredWebhooks: tableCountSafe("webhook_logs", "dead_lettered_at IS NOT NULL"),
    },
    operations: {
      onlineCouriers: tableCountSafe("couriers", "status = ?", [COURIER_ONLINE_STATUS]),
      busyCouriers: tableCountSafe("couriers", "status = ?", [COURIER_BUSY_STATUS]),
      waitingPackages: db.prepare(`
        SELECT COUNT(*) AS count FROM packages
        WHERE status IN (?, ?, ?, ?)
      `).get(PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS).count,
    },
    integrations: {
      incomingWebhook: {
        enabled: WEBHOOK_ENABLED,
        secretConfigured: Boolean(WEBHOOK_SECRET),
        allowedIpsConfigured: WEBHOOK_ALLOWED_IPS.length > 0,
      },
      posentegra: {
        outboundConfigured: posentegraClient.configured(),
        businessIdConfigured: Boolean(posentegraClient.businessId()),
        outbox: posentegraOutbox.health(),
      },
      platforms: {
        accountCount: tableCountSafe("platform_accounts"),
        legacyMappedRestaurantCount: tableCountSafe("restaurants", `
          (posentegra_id IS NOT NULL AND posentegra_id != '')
          OR (trendyol_restaurant_id IS NOT NULL AND trendyol_restaurant_id != '')
          OR (yemeksepeti_restaurant_id IS NOT NULL AND yemeksepeti_restaurant_id != '')
          OR (getir_restaurant_id IS NOT NULL AND getir_restaurant_id != '')
          OR (migros_restaurant_id IS NOT NULL AND migros_restaurant_id != '')
        `),
        callbackAccountCount: tableCountSafe("platform_accounts", "active = 1 AND callback_url IS NOT NULL AND callback_url != ''"),
        globalCallbackConfigured: Boolean(trimmed(process.env.DELIVERA_PLATFORM_CALLBACK_URL || process.env.PLATFORM_CALLBACK_URL)),
      },
    },
    queues: queueHealthPayload(),
    cache: cacheHealthPayload(),
    platformHealth: platformHealthSummaryPayload(),
    timestamp: nowIso(),
  };
}

function performanceSummaryPayload() {
  const averageResponseTimeMs = performanceMetrics.requestCount
    ? performanceMetrics.totalResponseTimeMs / performanceMetrics.requestCount
    : 0;
  const recent = [...performanceMetrics.recentResponseTimes].sort((left, right) => left - right);
  const percentile = (value) => {
    if (recent.length === 0) {
      return 0;
    }
    return recent[Math.min(recent.length - 1, Math.ceil((value / 100) * recent.length) - 1)];
  };

  return {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(performanceMetrics.startedAt).toISOString(),
    requestCount: performanceMetrics.requestCount,
    errorCount: performanceMetrics.errorCount,
    averageResponseTimeMs: Number(averageResponseTimeMs.toFixed(2)),
    maxResponseTimeMs: performanceMetrics.maxResponseTimeMs,
    p50ResponseTimeMs: percentile(50),
    p95ResponseTimeMs: percentile(95),
    p99ResponseTimeMs: percentile(99),
    statusBuckets: performanceMetrics.statusBuckets,
    memory: process.memoryUsage(),
    databaseSizeBytes: databaseSizeBytes(),
    queues: queueHealthPayload(),
    cache: cacheHealthPayload(),
    platformHealth: platformHealthSummaryPayload(),
    recentRequests: recentRequestLogs.slice(-10),
    timestamp: nowIso(),
  };
}

function prometheusLine(name, value, labels = {}) {
  const labelEntries = Object.entries(labels).filter(([, labelValue]) => labelValue !== undefined && labelValue !== null);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([labelName, labelValue]) => `${labelName}="${String(labelValue).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
    : "";
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${name}${labelText} ${numericValue}`;
}

function metricsTextPayload() {
  const status = systemStatusPayload();
  const perf = performanceSummaryPayload();
  const lines = [
    "# HELP delivera_up Application liveness flag.",
    "# TYPE delivera_up gauge",
    prometheusLine("delivera_up", status.ok ? 1 : 0),
    "# HELP delivera_uptime_seconds Process uptime in seconds.",
    "# TYPE delivera_uptime_seconds gauge",
    prometheusLine("delivera_uptime_seconds", status.uptimeSeconds),
    "# HELP delivera_requests_total Total observed HTTP requests.",
    "# TYPE delivera_requests_total counter",
    prometheusLine("delivera_requests_total", perf.requestCount),
    "# HELP delivera_errors_total Total observed HTTP 5xx responses.",
    "# TYPE delivera_errors_total counter",
    prometheusLine("delivera_errors_total", perf.errorCount),
    "# HELP delivera_response_time_ms HTTP response time summary in milliseconds.",
    "# TYPE delivera_response_time_ms gauge",
    prometheusLine("delivera_response_time_ms", perf.averageResponseTimeMs, { quantile: "avg" }),
    prometheusLine("delivera_response_time_ms", perf.p50ResponseTimeMs, { quantile: "p50" }),
    prometheusLine("delivera_response_time_ms", perf.p95ResponseTimeMs, { quantile: "p95" }),
    prometheusLine("delivera_response_time_ms", perf.p99ResponseTimeMs, { quantile: "p99" }),
    "# HELP delivera_database_size_bytes SQLite database file size.",
    "# TYPE delivera_database_size_bytes gauge",
    prometheusLine("delivera_database_size_bytes", status.database.sizeBytes),
    "# HELP delivera_table_rows Current table row counts.",
    "# TYPE delivera_table_rows gauge",
    prometheusLine("delivera_table_rows", status.totals.restaurants, { table: "restaurants" }),
    prometheusLine("delivera_table_rows", status.totals.couriers, { table: "couriers" }),
    prometheusLine("delivera_table_rows", status.totals.packages, { table: "packages" }),
    prometheusLine("delivera_table_rows", status.totals.platformOrders, { table: "platform_orders" }),
    "# HELP delivera_couriers Current courier operational counts.",
    "# TYPE delivera_couriers gauge",
    prometheusLine("delivera_couriers", status.operations.onlineCouriers, { status: "online" }),
    prometheusLine("delivera_couriers", status.operations.busyCouriers, { status: "busy" }),
    "# HELP delivera_queue_depth In-process queue/timer depth.",
    "# TYPE delivera_queue_depth gauge",
    prometheusLine("delivera_queue_depth", status.queues.assignmentRetryTimers, { queue: "assignment_retry_timers" }),
    prometheusLine("delivera_queue_depth", status.queues.liveStreams, { queue: "live_streams" }),
  ];

  Object.entries(perf.statusBuckets || {}).forEach(([statusCode, count]) => {
    lines.push(prometheusLine("delivera_http_status_total", count, { status: statusCode }));
  });

  return `${lines.join("\n")}\n`;
}

function findStaticFile(pathname, method = "GET") {
  if (STATIC_FILES[pathname]) {
    return STATIC_FILES[pathname];
  }

  if (!["GET", "HEAD"].includes(method)) {
    return "";
  }

  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return "";
  }

  if (!decodedPath || decodedPath.includes("\0") || decodedPath.includes("..")) {
    return "";
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath || relativePath.startsWith("api/")) {
    return "";
  }

  const ext = path.extname(relativePath).toLowerCase();
  const allowedExts = new Set([".html", ".css", ".js", ".json", ".webmanifest", ".png", ".jpg", ".jpeg", ".svg", ".ico"]);
  if (!allowedExts.has(ext)) {
    return "";
  }

  const filePath = path.resolve(__dirname, relativePath);
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return "";
  }

  return relativePath;
}

function notFound(res) {
  sendJson(res, 404, { error: "Kaynak bulunamadi." });
}

function getZones() {
  return db.prepare("SELECT name FROM zones ORDER BY name").all().map((row) => row.name);
}

function getRestaurants(filter = {}) {
  const pagination = filter.pagination || null;
  const limitSql = pagination ? " LIMIT ? OFFSET ?" : "";
  const limitParams = pagination ? [clampLimit(pagination.limit), parsePositiveInteger(pagination.offset)] : [];
  const rows = filter.restaurantId
    ? db.prepare(`SELECT * FROM restaurants WHERE id = ? ORDER BY datetime(created_at) DESC${limitSql}`).all(filter.restaurantId, ...limitParams)
    : db.prepare(`SELECT * FROM restaurants ORDER BY datetime(created_at) DESC${limitSql}`).all(...limitParams);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    zone: row.zone,
    latitude: row.x,
    longitude: row.y,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    platforms: parseJson(row.platforms_json, []),
    trendyolRestaurantId: row.trendyol_restaurant_id || "",
    yemeksepetiRestaurantId: row.yemeksepeti_restaurant_id || "",
    getirRestaurantId: row.getir_restaurant_id || "",
    migrosRestaurantId: row.migros_restaurant_id || "",
    posentegraId: row.posentegra_id || "",
    externalRestaurantIds: parseExternalRestaurantIds(row.external_restaurant_ids),
    apiKey: row.api_key,
    webhookSecret: row.webhook_secret,
    createdAt: row.created_at,
  }));
}

function getCouriers(filter = {}) {
  const pagination = filter.pagination || null;
  const limitSql = pagination ? " LIMIT ? OFFSET ?" : "";
  const limitParams = pagination ? [clampLimit(pagination.limit), parsePositiveInteger(pagination.offset)] : [];
  return db.prepare(`SELECT * FROM couriers ORDER BY datetime(created_at) DESC${limitSql}`).all(...limitParams).map((row) => ({
    id: row.id,
    name: row.name,
    zone: row.zone,
    latitude: row.x,
    longitude: row.y,
    available: Boolean(row.available),
    status: normalizeCourierStatus(row.status, Boolean(row.available)),
    lastLocationAt: row.last_location_at,
    perPackageFee: row.per_package_fee === null || row.per_package_fee === undefined ? null : Number(row.per_package_fee || 0),
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
  }));
}

function getCourierById(courierId) {
  const row = db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    zone: row.zone,
    latitude: row.x,
    longitude: row.y,
    available: Boolean(row.available),
    status: normalizeCourierStatus(row.status, Boolean(row.available)),
    lastLocationAt: row.last_location_at,
    perPackageFee: row.per_package_fee === null || row.per_package_fee === undefined ? null : Number(row.per_package_fee || 0),
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
  };
}

function getPackages(filter = {}) {
  const whereParts = [];
  const params = [];
  if (filter.restaurantId) {
    whereParts.push("restaurant_id = ?");
    params.push(filter.restaurantId);
  }
  if (filter.courierId) {
    whereParts.push("assigned_courier_id = ?");
    params.push(filter.courierId);
  }
  if (filter.status) {
    whereParts.push("status = ?");
    params.push(normalizeStatus(filter.status));
  }
  if (filter.platform) {
    whereParts.push("source_platform = ?");
    params.push(filter.platform);
  }
  if (filter.assignedOnly) {
    whereParts.push("assigned_courier_id IS NOT NULL");
  }
  if (filter.dateFrom) {
    whereParts.push("created_at >= ?");
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    whereParts.push("created_at <= ?");
    params.push(filter.dateTo);
  }
  if (filter.search) {
    whereParts.push("(tracking_no LIKE ? OR external_order_no LIKE ? OR recipient LIKE ? OR phone LIKE ? OR address LIKE ? OR delivery_address LIKE ?)");
    const searchValue = `%${filter.search}%`;
    params.push(searchValue, searchValue, searchValue, searchValue, searchValue, searchValue);
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const pagination = filter.pagination || null;
  const sql = `SELECT * FROM packages ${whereSql} ORDER BY datetime(created_at) DESC`;
  const rows = pagination
    ? db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, clampLimit(pagination.limit), parsePositiveInteger(pagination.offset))
    : db.prepare(sql).all(...params);
  const platformOrderLookup = buildPlatformOrderLookup(rows);

  return rows.map((row) => {
    const platformOrder = platformOrderLookup(row);
    return {
    id: row.id,
    trackingNo: row.tracking_no,
    restaurantId: row.restaurant_id,
    source: normalizeOrderSource(row.source, row.source_platform),
    platform: row.source_platform || row.source,
    deliveryAddress: row.delivery_address || row.address,
    packageType: row.package_type || "Standart Paket",
    sourcePlatform: row.source_platform,
    platformSlug: row.platform_slug || "",
    externalOrderNo: row.external_order_no,
    externalOrderId: row.external_order_id || row.external_order_no,
    platformOrderId: platformOrder?.platformOrderId || row.external_order_id || row.external_order_no,
    platformRestaurantId: row.platform_restaurant_id || platformOrder?.platformRestaurantId || row.external_restaurant_id || "",
    posentegraId: row.posentegra_id || platformOrder?.posentegraId || "",
    platformOrderDbId: platformOrder?.id || "",
    confirmationId: row.confirmation_id || "",
    externalRestaurantId: row.external_restaurant_id || "",
    restaurantNameFromPayload: row.restaurant_name_from_payload || "",
    providerId: row.provider_id || "",
    providerName: row.provider_name || "",
    recipient: row.recipient,
    phone: row.phone,
    contactPhone: row.contact_phone || "",
    address: row.address,
    city: row.city || "",
    district: row.district || "",
    street: row.street || "",
    buildingNo: row.building_no || "",
    floor: row.floor || "",
    doorNo: row.door_no || "",
    addressDescription: row.address_description || "",
    zone: row.zone,
    eta: row.eta,
    paymentMethod: row.payment_method,
    paymentMethodCode: normalizePaymentMethodCode(row.payment_method),
    orderAmount: Number(row.order_amount || 0),
    paymentStatus: normalizePaymentStatus(row.payment_status, row.payment_method),
    paymentCollectedBy: row.payment_collected_by || normalizeCollectedBy(row.payment_status),
    collectedAmount: Number(row.collected_amount || 0),
    courierCollectionNote: row.courier_collection_note || "",
    customerId: row.customer_id || row.restaurant_customer_id || "",
    restaurantCustomerId: row.restaurant_customer_id || row.customer_id || "",
    latitude: row.x,
    longitude: row.y,
    note: row.note,
    customerNote: row.customer_note || "",
    discountedPrice: Number(row.discounted_price || 0),
    totalDiscount: Number(row.total_discount || 0),
    posPaymentMethod: row.pos_payment_method || "",
    posTicket: row.pos_ticket || "",
    shortCode: row.short_code || "",
    deliveryType: row.delivery_type || "",
    isScheduled: Boolean(row.is_scheduled),
    scheduledDate: row.scheduled_date || null,
    customerLat: row.customer_lat,
    customerLng: row.customer_lng,
    customerAddress: row.customer_address || row.delivery_address || row.address,
    restaurantLat: row.x,
    restaurantLng: row.y,
    restaurantAddress: row.zone,
    items: parseJson(row.items_json, []),
    rawPayload: parseJson(row.raw_payload_json, null),
    platformStatusLogs: parseJson(row.platform_status_logs_json, []),
    status: normalizeStatus(row.status),
    statusText: row.status_text || "",
    rawStatus: row.raw_status || "",
    assignmentStatus: row.assignment_status || assignmentStatusForOrder(row.status),
    assignedCourierId: row.assigned_courier_id,
    assignedCourierName: row.assigned_courier_name,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at,
    onRouteAt: row.on_route_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    distanceKm: row.distance_km,
    assignmentReason: row.assignment_reason,
    failureReason: row.failure_reason || "",
    lastAssignmentAttemptAt: row.last_assignment_attempt_at,
    lastAssignmentError: row.last_assignment_error || "",
    assignmentTriedCourierIds: normalizeIdList(parseJson(row.assignment_tried_courier_ids_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    };
  });
}

function packagePagination(filter = {}, pagination = { limit: DEFAULT_PAGE_LIMIT, offset: 0 }) {
  const whereParts = [];
  const params = [];
  if (filter.restaurantId) {
    whereParts.push("restaurant_id = ?");
    params.push(filter.restaurantId);
  }
  if (filter.courierId) {
    whereParts.push("assigned_courier_id = ?");
    params.push(filter.courierId);
  }
  if (filter.status) {
    whereParts.push("status = ?");
    params.push(normalizeStatus(filter.status));
  }
  if (filter.platform) {
    whereParts.push("source_platform = ?");
    params.push(filter.platform);
  }
  if (filter.assignedOnly) {
    whereParts.push("assigned_courier_id IS NOT NULL");
  }
  if (filter.dateFrom) {
    whereParts.push("created_at >= ?");
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    whereParts.push("created_at <= ?");
    params.push(filter.dateTo);
  }
  if (filter.search) {
    whereParts.push("(tracking_no LIKE ? OR external_order_no LIKE ? OR recipient LIKE ? OR phone LIKE ? OR address LIKE ? OR delivery_address LIKE ?)");
    const searchValue = `%${filter.search}%`;
    params.push(searchValue, searchValue, searchValue, searchValue, searchValue, searchValue);
  }
  const total = db.prepare(`SELECT COUNT(*) AS count FROM packages${whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : ""}`).get(...params).count;
  return pageMeta(total, pagination);
}

function getCapacityPackagesForAssignment(pkg) {
  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE status IN (?, ?, ?)
      AND id <> ?
  `).all(ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, pkg.id);
  return [...rows.map((row) => mapPackageRow(row)), pkg];
}

function assignmentStateForPackage(pkg) {
  return {
    zones: getZones(),
    restaurants: getRestaurants({ restaurantId: pkg.restaurantId }),
    couriers: getCouriers(),
    packages: getCapacityPackagesForAssignment(pkg),
    platformAccounts: [],
    platformOrders: [],
    webhookLogs: [],
  };
}

function mapPackageRow(row, restaurantMap = new Map(), platformOrder) {
  if (arguments.length < 3) {
    platformOrder = getPlatformOrderForPackageRow(row);
  }
  return {
    id: row.id,
    trackingNo: row.tracking_no,
    restaurantId: row.restaurant_id,
    source: normalizeOrderSource(row.source, row.source_platform),
    platform: row.source_platform || row.source,
    deliveryAddress: row.delivery_address || row.address,
    packageType: row.package_type || "Standart Paket",
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    externalOrderId: row.external_order_id || row.external_order_no,
    platformOrderId: platformOrder?.platformOrderId || row.external_order_id || row.external_order_no,
    platformRestaurantId: row.platform_restaurant_id || platformOrder?.platformRestaurantId || row.external_restaurant_id || "",
    posentegraId: row.posentegra_id || platformOrder?.posentegraId || "",
    platformOrderDbId: platformOrder?.id || "",
    recipient: row.recipient,
    phone: row.phone,
    address: row.address,
    zone: row.zone,
    eta: row.eta,
    paymentMethod: row.payment_method,
    paymentMethodCode: normalizePaymentMethodCode(row.payment_method),
    orderAmount: Number(row.order_amount || 0),
    paymentStatus: normalizePaymentStatus(row.payment_status, row.payment_method),
    paymentCollectedBy: row.payment_collected_by || normalizeCollectedBy(row.payment_status),
    collectedAmount: Number(row.collected_amount || 0),
    courierCollectionNote: row.courier_collection_note || "",
    customerId: row.customer_id || row.restaurant_customer_id || "",
    restaurantCustomerId: row.restaurant_customer_id || row.customer_id || "",
    latitude: row.x,
    longitude: row.y,
    note: row.note,
    customerNote: row.customer_note || "",
    customerLat: row.customer_lat,
    customerLng: row.customer_lng,
    customerAddress: row.customer_address || row.delivery_address || row.address,
    restaurantLat: row.x,
    restaurantLng: row.y,
    restaurantAddress: row.zone,
    items: parseJson(row.items_json, []),
    rawPayload: parseJson(row.raw_payload_json, null),
    platformStatusLogs: parseJson(row.platform_status_logs_json, []),
    status: normalizeStatus(row.status),
    assignmentStatus: row.assignment_status || assignmentStatusForOrder(row.status),
    assignedCourierId: row.assigned_courier_id,
    assignedCourierName: row.assigned_courier_name,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at,
    onRouteAt: row.on_route_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    distanceKm: row.distance_km,
    assignmentReason: row.assignment_reason,
    failureReason: row.failure_reason || "",
    lastAssignmentAttemptAt: row.last_assignment_attempt_at,
    lastAssignmentError: row.last_assignment_error || "",
    assignmentTriedCourierIds: normalizeIdList(parseJson(row.assignment_tried_courier_ids_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    restaurantName: restaurantMap.get(row.restaurant_id) || "Bilinmeyen Restoran",
  };
}

function getCourierPackages(courierId, pagination = null) {
  const rows = pagination
    ? db.prepare(`SELECT * FROM packages WHERE assigned_courier_id = ? ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?`).all(courierId, clampLimit(pagination.limit), parsePositiveInteger(pagination.offset))
    : db.prepare(`SELECT * FROM packages WHERE assigned_courier_id = ? ORDER BY datetime(created_at) DESC`).all(courierId);
  const platformOrderLookup = buildPlatformOrderLookup(rows);
  const restaurantIds = [...new Set(rows.map((row) => row.restaurant_id))];
  const restaurantMap = new Map(
    restaurantIds.map((restaurantId) => {
      const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(restaurantId);
      return [restaurantId, restaurant?.name || "Bilinmeyen Restoran"];
    })
  );

  return rows.map((row) => mapPackageRow(row, restaurantMap, platformOrderLookup(row)));
}

function getCourierPoolPackages(courierId, limit = 100) {
  const activeLoad = Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM packages
    WHERE assigned_courier_id = ?
      AND status IN (?, ?, ?)
  `).get(courierId, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0);
  if (activeLoad < 1 || activeLoad >= COURIER_POOL_MAX_ACTIVE_PACKAGES) {
    return [];
  }

  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE assigned_courier_id IS NULL
      AND status IN (?, ?, ?)
      AND last_assignment_attempt_at IS NOT NULL
      AND last_assignment_error IS NOT NULL
      AND last_assignment_error <> ''
    ORDER BY datetime(created_at) ASC
    LIMIT ?
  `).all(PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, clampLimit(limit));
  if (rows.length === 0) return [];
  const state = {
    restaurants: getRestaurants(),
    couriers: getCouriers(),
    packages: getPackages(),
  };
  return mapPackageRowsWithRestaurants(rows).filter((pkg) => isCourierPoolFallbackPackage(pkg, state));
}

function normalizePhone(value) {
  return trimmed(value).replace(/[^\d]/g, "").replace(/^90(?=5)/, "");
}

function mapCustomerRow(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    note: row.note || "",
    orderCount: Number(row.order_count || 0),
    lastOrderAt: row.last_order_at || null,
    isActive: row.is_active === undefined || row.is_active === null ? true : Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function getRestaurantCustomers(restaurantId, search = "") {
  const normalizedSearch = normalizePhone(search);
  if (normalizedSearch) {
    return db.prepare(`
      SELECT * FROM customers
      WHERE restaurant_id = ? AND is_active != 0 AND phone LIKE ?
      ORDER BY datetime(updated_at) DESC
      LIMIT 10
    `).all(restaurantId, `%${normalizedSearch}%`).map(mapCustomerRow);
  }
  return db.prepare(`
    SELECT * FROM customers
    WHERE restaurant_id = ? AND is_active != 0
    ORDER BY datetime(updated_at) DESC
    LIMIT 50
  `).all(restaurantId).map(mapCustomerRow);
}

function upsertRestaurantCustomer(restaurantId, payload = {}) {
  const name = trimmed(payload.name || payload.customerName);
  const phone = normalizePhone(payload.phone);
  const address = trimmed(payload.address || payload.customerAddress || payload.deliveryAddress);
  const note = trimmed(payload.note || payload.customerNote);
  if (!phone) {
    return null;
  }
  if (!name || !address) {
    throw httpError(400, "Musteri kaydi icin ad, telefon ve adres zorunludur.");
  }
  const existing = db.prepare("SELECT * FROM customers WHERE restaurant_id = ? AND phone = ?").get(restaurantId, phone);
  const stamp = nowIso();
  if (existing) {
    db.prepare("UPDATE customers SET name = ?, address = ?, note = ?, is_active = 1, updated_at = ? WHERE id = ?").run(name, address, note || existing.note || "", stamp, existing.id);
    return mapCustomerRow(db.prepare("SELECT * FROM customers WHERE id = ?").get(existing.id));
  }
  const id = uid("cust");
  db.prepare(`
    INSERT INTO customers (id, restaurant_id, name, phone, address, note, order_count, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, restaurantId, name, phone, address, note, stamp, stamp);
  return mapCustomerRow(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
}

function updateRestaurantCustomer(customerId, restaurantId, payload = {}) {
  const existing = db.prepare("SELECT * FROM customers WHERE id = ? AND restaurant_id = ?").get(customerId, restaurantId);
  if (!existing) {
    throw httpError(404, "Musteri bulunamadi.");
  }
  const name = trimmed(payload.name ?? existing.name);
  const phone = normalizePhone(payload.phone ?? existing.phone);
  const address = trimmed(payload.address ?? existing.address);
  const note = trimmed(payload.note ?? existing.note ?? "");
  if (!name || !phone || !address) {
    throw httpError(400, "Musteri adi, telefon ve adres zorunludur.");
  }
  db.prepare(`
    UPDATE customers
    SET name = ?, phone = ?, address = ?, note = ?, is_active = ?, updated_at = ?
    WHERE id = ? AND restaurant_id = ?
  `).run(name, phone, address, note, payload.isActive === false ? 0 : 1, nowIso(), customerId, restaurantId);
  return mapCustomerRow(db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId));
}

function softDeleteRestaurantCustomer(customerId, restaurantId) {
  const result = db.prepare("UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ? AND restaurant_id = ?").run(nowIso(), customerId, restaurantId);
  if (!result.changes) {
    throw httpError(404, "Musteri bulunamadi.");
  }
}

function touchRestaurantCustomerOrder(customerId, restaurantId, stamp = nowIso()) {
  if (!customerId) {
    return;
  }
  db.prepare(`
    UPDATE customers
    SET order_count = COALESCE(order_count, 0) + 1,
        last_order_at = ?,
        updated_at = ?
    WHERE id = ? AND restaurant_id = ?
  `).run(stamp, stamp, customerId, restaurantId);
}

function packagesForRestaurantPeriod({ restaurantId = "", startDate = "", endDate = "", statuses = [] } = {}) {
  const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : [statuses]).map(normalizeStatus).filter(Boolean))];
  const where = [];
  const params = [];
  if (normalizedStatuses.length) {
    where.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
    params.push(...normalizedStatuses);
  }
  if (restaurantId) {
    where.push("restaurant_id = ?");
    params.push(restaurantId);
  }
  if (startDate) {
    where.push("substr(COALESCE(delivered_at, failed_at, updated_at, created_at), 1, 10) >= ?");
    params.push(startDate);
  }
  if (endDate) {
    where.push("substr(COALESCE(delivered_at, failed_at, updated_at, created_at), 1, 10) <= ?");
    params.push(endDate);
  }
  const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM packages ${predicate} ORDER BY datetime(COALESCE(delivered_at, failed_at, updated_at, created_at)) DESC`).all(...params);
  const platformOrderLookup = buildPlatformOrderLookup(rows);
  return rows.map((row) => mapPackageRow(row, new Map(), platformOrderLookup(row)));
}

function getSystemCurtainState() {
  const row = db.prepare("SELECT settings_json FROM system_settings WHERE id = ?").get(CURTAIN_SETTINGS_ID);
  const stored = parseJson(row?.settings_json, {});
  return {
    active: stored.active === true,
    updatedAt: trimmed(stored.updatedAt) || null,
  };
}

function updateSystemCurtainState(active) {
  const state = {
    active: active === true,
    updatedAt: nowIso(),
  };
  db.prepare(`
    INSERT INTO system_settings (id, settings_json) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json
  `).run(CURTAIN_SETTINGS_ID, json(state));
  return state;
}

function systemCurtainControlTokenIsValid(token) {
  const candidate = trimmed(token);
  if (!candidate || candidate.length > 256 || !CURTAIN_CONTROL_TOKEN_HASH) {
    return false;
  }
  const candidateHash = crypto.createHash("sha256").update(candidate).digest("hex");
  return timingSafeStringEqual(candidateHash, CURTAIN_CONTROL_TOKEN_HASH);
}

function packagesForAccounting({ restaurantId = "", startDate = "", endDate = "" } = {}) {
  return packagesForRestaurantPeriod({ restaurantId, startDate, endDate, statuses: [DELIVERED_STATUS] });
}

function isCancelledAccountingPackage(pkg) {
  return [FAILED_STATUS, REJECTED_STATUS, CANCELED_STATUS, "canceled"].includes(normalizeStatus(pkg?.status));
}

function accountingBucketForPackage(pkg) {
  const status = normalizePaymentStatus(pkg.paymentStatus, pkg.paymentMethod);
  const methodCode = normalizePaymentMethodCode(pkg.paymentMethod);
  if (status === PAYMENT_ISSUE_STATUS || methodCode === "payment_issue") return "issue";
  if ([CASH_COLLECTED_PAYMENT_STATUS, CASH_EXPECTED_PAYMENT_STATUS].includes(status) || methodCode === "cash_on_delivery") return "cash";
  if ([CREDIT_CARD_PAYMENT_STATUS, CREDIT_CARD_COLLECTED_PAYMENT_STATUS].includes(status) || methodCode === "card_on_delivery") return "card";
  if (status === PAID_ONLINE_PAYMENT_STATUS || methodCode === "paid_online") return "online";
  if (status === RESTAURANT_COLLECTED_PAYMENT_STATUS || methodCode === "restaurant_collected") return "restaurant";
  if (status === COLLECTED_PAYMENT_STATUS || methodCode === "collected") return "restaurant";
  return "unknown";
}

function summarizeRestaurantAccounting(packages, settings = getSystemSettings()) {
  const feeCents = moneyToCents(settings.courier_per_package_fee || 0);
  const totals = packages.reduce((summary, pkg) => {
    const amountCents = moneyToCents(pkg.orderAmount);
    const bucket = accountingBucketForPackage(pkg);
    summary.totalPackages += 1;
    if (bucket === "cash") summary.totalCashCents += amountCents;
    if (bucket === "card") summary.totalCardCents += amountCents;
    if (bucket === "online") summary.totalOnlineCents += amountCents;
    if (bucket === "restaurant") summary.totalRestaurantCollectedCents += amountCents;
    const paymentStatus = normalizePaymentStatus(pkg.paymentStatus, pkg.paymentMethod);
    const collectedBy = normalizeCollectedBy(paymentStatus, pkg.paymentCollectedBy);
    if (
      [CASH_COLLECTED_PAYMENT_STATUS, CREDIT_CARD_COLLECTED_PAYMENT_STATUS].includes(paymentStatus) ||
      (paymentStatus === COLLECTED_PAYMENT_STATUS && collectedBy === "courier")
    ) summary.totalCourierCollectedCents += amountCents;
    if (bucket === "issue") summary.failedCollectionCents += amountCents;
    return summary;
  }, {
    totalPackages: 0,
    totalCashCents: 0,
    totalCardCents: 0,
    totalOnlineCents: 0,
    totalRestaurantCollectedCents: 0,
    totalCourierCollectedCents: 0,
    failedCollectionCents: 0,
  });
  const serviceFeeCents = totals.totalPackages * feeCents;
  const netPayableCents = Math.max(0, totals.totalCourierCollectedCents - serviceFeeCents);
  return {
    totalPackages: totals.totalPackages,
    totalCash: centsToMoney(totals.totalCashCents),
    totalCard: centsToMoney(totals.totalCardCents),
    totalOnline: centsToMoney(totals.totalOnlineCents),
    totalRestaurantCollected: centsToMoney(totals.totalRestaurantCollectedCents),
    totalCourierCollected: centsToMoney(totals.totalCourierCollectedCents),
    failedCollectionTotal: centsToMoney(totals.failedCollectionCents),
    serviceFee: centsToMoney(serviceFeeCents),
    netPayable: centsToMoney(netPayableCents),
  };
}

function buildRestaurantAccounting({ startDate = dayKey(), endDate = dayKey(), restaurantId = "" } = {}) {
  const restaurants = getRestaurants({ restaurantId: trimmed(restaurantId) });
  return restaurants.map((restaurant) => {
    const periodPackages = packagesForRestaurantPeriod({ restaurantId: restaurant.id, startDate, endDate });
    const packages = periodPackages.filter((pkg) => normalizeStatus(pkg.status) === DELIVERED_STATUS);
    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      startDate,
      endDate,
      ...summarizeRestaurantAccounting(packages),
      totalSubmittedPackages: periodPackages.length,
      totalCancelledPackages: periodPackages.filter(isCancelledAccountingPackage).length,
      packages,
    };
  });
}

function buildRestaurantAccountingDetails(restaurantId, filters = {}) {
  const startDate = trimmed(filters.startDate) || dayKey();
  const endDate = trimmed(filters.endDate) || startDate;
  const settlement = db.prepare("SELECT * FROM restaurant_settlements WHERE restaurant_id = ? AND start_date = ? AND end_date = ?").get(restaurantId, startDate, endDate);
  const paymentMethod = normalizePaymentMethodCode(filters.paymentMethod || "");
  const paymentStatus = trimmed(filters.paymentStatus || filters.collectionStatus);
  const courierId = trimmed(filters.courierId);
  const paidFilter = trimmed(filters.paidStatus || filters.settlementStatus);
  const periodPackages = packagesForRestaurantPeriod({ restaurantId, startDate, endDate });
  const cancelledPackages = periodPackages.filter(isCancelledAccountingPackage);
  let packages = periodPackages.filter((pkg) => normalizeStatus(pkg.status) === DELIVERED_STATUS);
  if (paymentMethod) {
    packages = packages.filter((pkg) => pkg.paymentMethodCode === paymentMethod);
  }
  if (paymentStatus) {
    packages = packages.filter((pkg) => normalizePaymentStatus(pkg.paymentStatus, pkg.paymentMethod) === normalizePaymentStatus(paymentStatus, pkg.paymentMethod));
  }
  if (courierId) {
    packages = packages.filter((pkg) => pkg.assignedCourierId === courierId);
  }
  if (paidFilter === "paid" && settlement?.status !== "paid") {
    packages = [];
  }
  if (paidFilter === "unpaid" && settlement?.status === "paid") {
    packages = [];
  }
  return {
    restaurantId,
    startDate,
    endDate,
    settlement: settlement ? mapSettlementRow(settlement) : null,
    summary: summarizeRestaurantAccounting(packages),
    packageStats: {
      totalSubmittedPackages: periodPackages.length,
      totalDeliveredPackages: packages.length,
      totalCancelledPackages: cancelledPackages.length,
    },
    packages: packages.map((pkg) => ({
      id: pkg.id,
      trackingNo: pkg.trackingNo,
      date: pkg.deliveredAt || pkg.updatedAt || pkg.createdAt,
      customer: pkg.recipient,
      courier: pkg.assignedCourierName || "",
      courierId: pkg.assignedCourierId || "",
      amount: pkg.orderAmount,
      paymentMethod: pkg.paymentMethod,
      paymentStatus: pkg.paymentStatus,
      paymentCollectedBy: pkg.paymentCollectedBy,
      status: pkg.status,
      note: pkg.courierCollectionNote || pkg.customerNote || pkg.note || "",
    })),
    cancelledPackages: cancelledPackages.map((pkg) => ({
      id: pkg.id,
      trackingNo: pkg.trackingNo,
      date: pkg.failedAt || pkg.updatedAt || pkg.createdAt,
      customer: pkg.recipient,
      courier: pkg.assignedCourierName || "",
      courierId: pkg.assignedCourierId || "",
      amount: pkg.orderAmount,
      paymentMethod: pkg.paymentMethod,
      paymentStatus: pkg.paymentStatus,
      status: pkg.status,
      note: pkg.failureReason || pkg.customerNote || pkg.note || "",
    })),
  };
}

function mapSettlementRow(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    startDate: row.start_date,
    endDate: row.end_date,
    totalPackages: Number(row.total_packages || 0),
    totalCash: Number(row.total_cash || 0),
    totalCard: Number(row.total_card || 0),
    totalOnline: Number(row.total_online || 0),
    totalRestaurantCollected: Number(row.total_restaurant_collected || 0),
    totalCourierCollected: Number(row.total_courier_collected || 0),
    serviceFee: Number(row.service_fee || 0),
    netPayable: Number(row.net_payable || 0),
    status: row.status,
    paidAt: row.paid_at || null,
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRestaurantSettlements(limit = 50, restaurantId = "") {
  const rows = restaurantId
    ? db.prepare("SELECT * FROM restaurant_settlements WHERE restaurant_id = ? ORDER BY datetime(updated_at) DESC LIMIT ?").all(restaurantId, limit)
    : db.prepare("SELECT * FROM restaurant_settlements ORDER BY datetime(updated_at) DESC LIMIT ?").all(limit);
  return rows.map(mapSettlementRow);
}

function upsertRestaurantSettlement(restaurantId, startDate, endDate, payload = {}) {
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(restaurantId);
  if (!restaurant) {
    throw httpError(404, "Restoran bulunamadi.");
  }
  const packages = packagesForAccounting({ restaurantId, startDate, endDate });
  const summary = summarizeRestaurantAccounting(packages);
  const existing = db.prepare("SELECT * FROM restaurant_settlements WHERE restaurant_id = ? AND start_date = ? AND end_date = ?").get(restaurantId, startDate, endDate);
  const stamp = nowIso();
  const status = trimmed(payload.status) || existing?.status || "unpaid";
  const paidAt = status === "paid" ? (trimmed(payload.paidAt) || existing?.paid_at || stamp) : null;
  const note = trimmed(payload.note) || existing?.note || "";
  if (existing) {
    db.prepare(`
      UPDATE restaurant_settlements
      SET total_packages = ?, total_cash = ?, total_card = ?, total_online = ?, total_restaurant_collected = ?,
          total_courier_collected = ?, service_fee = ?, net_payable = ?, status = ?, paid_at = ?, note = ?, updated_at = ?
      WHERE id = ?
    `).run(
      summary.totalPackages,
      summary.totalCash,
      summary.totalCard,
      summary.totalOnline,
      summary.totalRestaurantCollected,
      summary.totalCourierCollected,
      summary.serviceFee,
      summary.netPayable,
      status,
      paidAt,
      note,
      stamp,
      existing.id
    );
    return mapSettlementRow(db.prepare("SELECT * FROM restaurant_settlements WHERE id = ?").get(existing.id));
  }
  const id = uid("settlement");
  db.prepare(`
    INSERT INTO restaurant_settlements (
      id, restaurant_id, start_date, end_date, total_packages, total_cash, total_card, total_online,
      total_restaurant_collected, total_courier_collected, service_fee, net_payable, status, paid_at, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    restaurantId,
    startDate,
    endDate,
    summary.totalPackages,
    summary.totalCash,
    summary.totalCard,
    summary.totalOnline,
    summary.totalRestaurantCollected,
    summary.totalCourierCollected,
    summary.serviceFee,
    summary.netPayable,
    status,
    paidAt,
    note,
    stamp,
    stamp
  );
  return mapSettlementRow(db.prepare("SELECT * FROM restaurant_settlements WHERE id = ?").get(id));
}

function upsertSettlementsForApprovedReport(report) {
  const packageIds = parseJson(report.package_ids_json, []);
  if (!packageIds.length) {
    return [];
  }
  const placeholders = packageIds.map(() => "?").join(",");
  const restaurantIds = db.prepare(`SELECT DISTINCT restaurant_id FROM packages WHERE id IN (${placeholders})`).all(...packageIds).map((row) => row.restaurant_id);
  return restaurantIds.map((restaurantId) => upsertRestaurantSettlement(restaurantId, report.report_date, report.report_date));
}

function mapPackageRowsWithRestaurants(rows) {
  const restaurantIds = [...new Set(rows.map((row) => row.restaurant_id))];
  const restaurantMap = new Map(
    restaurantIds.map((restaurantId) => {
      const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(restaurantId);
      return [restaurantId, restaurant?.name || "Bilinmeyen Restoran"];
    })
  );
  const platformOrderLookup = buildPlatformOrderLookup(rows);

  return rows.map((row) => mapPackageRow(row, restaurantMap, platformOrderLookup(row)));
}

function getCourierHistoryPackages(courierId, limit = 500) {
  const historyLimit = Math.max(1, Math.min(1000, parsePositiveInteger(limit, 500)));
  const rows = db.prepare(`
    SELECT *
    FROM packages
    WHERE assigned_courier_id = ?
      AND status IN (?, ?, ?)
    ORDER BY datetime(COALESCE(delivered_at, failed_at, updated_at, created_at)) DESC
    LIMIT ?
  `).all(courierId, DELIVERED_STATUS, FAILED_STATUS, "cancelled", historyLimit);

  return mapPackageRowsWithRestaurants(rows);
}

function rangeStart(daysBack = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).toISOString();
}

function rangeEnd(daysForward = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysForward + 1).toISOString();
}

function isWithinRange(value, start, end) {
  if (!value) {
    return false;
  }
  const stamp = new Date(value).getTime();
  return !Number.isNaN(stamp) && stamp >= new Date(start).getTime() && stamp < new Date(end).getTime();
}

function diffMinutes(startValue, endValue) {
  if (!startValue || !endValue) {
    return null;
  }
  const diff = new Date(endValue).getTime() - new Date(startValue).getTime();
  if (Number.isNaN(diff) || diff < 0) {
    return null;
  }
  return diff / 60000;
}

function averageOf(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) {
    return 0;
  }
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1));
}

function getCourierShifts(courierId, limit = 20) {
  return db.prepare(`
    SELECT * FROM courier_shifts
    WHERE courier_id = ?
    ORDER BY datetime(started_at) DESC
    LIMIT ?
  `).all(courierId, limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getOpenCourierShift(courierId) {
  const row = db.prepare(`
    SELECT * FROM courier_shifts
    WHERE courier_id = ? AND ended_at IS NULL
    ORDER BY datetime(started_at) DESC
    LIMIT 1
  `).get(courierId);

  return row ? {
    id: row.id,
    courierId: row.courier_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function ensureCourierShiftOpen(courierId, startedAt = nowIso()) {
  if (!courierId || getOpenCourierShift(courierId)) {
    return;
  }

  db.prepare(`
    INSERT INTO courier_shifts (id, courier_id, started_at, ended_at, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
  `).run(uid("shift"), courierId, startedAt, startedAt, startedAt);
}

function closeCourierShift(courierId, endedAt = nowIso()) {
  const openShift = getOpenCourierShift(courierId);
  if (!openShift) {
    return;
  }

  db.prepare(`
    UPDATE courier_shifts
    SET ended_at = ?, updated_at = ?
    WHERE id = ?
  `).run(endedAt, endedAt, openShift.id);
  db.prepare("UPDATE courier_breaks SET ended_at = ?, updated_at = ? WHERE courier_id = ? AND ended_at IS NULL")
    .run(endedAt, endedAt, courierId);
}

function readinessPayload() {
  const issues = [];
  const warnings = [];
  const requireRedis = ["1", "true", "yes"].includes(String(process.env.RESTOMAP_REQUIRE_REDIS || process.env.DELIVERA_REQUIRE_REDIS || "").toLowerCase());
  let databaseOk = false;
  let databaseMode = "unknown";
  try {
    databaseMode = dbFacade.clientName();
    databaseOk = Boolean(db.prepare("SELECT 1 AS ok").get()?.ok);
  } catch (error) {
    issues.push(`database_unavailable:${error.message}`);
  }
  if (!databaseOk) issues.push("database_check_failed");
  if (IS_PRODUCTION && databaseMode !== "postgres") issues.push("production_requires_postgres");
  if (IS_PRODUCTION && WEBHOOK_ENABLED && !WEBHOOK_SECRET) issues.push("webhook_secret_required");
  if (!WEBHOOK_ENABLED) warnings.push("incoming_webhooks_disabled");

  const platformAccountCount = tableCountSafe("platform_accounts");
  const platformPackageCount = tableCountSafe("packages", "source = ?", ["platform_webhook"]);
  const callbackAccountCount = tableCountSafe("platform_accounts", "active = 1 AND callback_url IS NOT NULL AND callback_url != ''");
  const globalCallbackConfigured = Boolean(trimmed(process.env.DELIVERA_PLATFORM_CALLBACK_URL || process.env.PLATFORM_CALLBACK_URL));
  if (platformPackageCount > 0 && platformAccountCount === 0) warnings.push("platform_accounts_not_configured_legacy_matching_active");
  if (platformPackageCount > 0 && callbackAccountCount === 0 && !globalCallbackConfigured && !posentegraClient.configured()) {
    warnings.push("platform_status_callback_not_configured");
  }

  const queueHealth = queueService.health();
  if (requireRedis && (!REDIS_URL || queueHealth.mode !== "bullmq")) issues.push("redis_queue_required");
  else if (IS_PRODUCTION && (!REDIS_URL || queueHealth.mode !== "bullmq")) warnings.push("redis_queue_not_configured_inline_fallback_active");

  const dbEnv = dbFacade.databaseEnvInfo();
  return {
    ok: issues.length === 0,
    app: "RESTOMAP",
    database: {
      ok: databaseOk,
      mode: databaseMode,
      postgresRequired: dbEnv.postgresRequired,
      postgresConfigured: dbEnv.configured,
    },
    queue: {
      mode: queueHealth.mode,
      redisConfigured: Boolean(REDIS_URL),
      required: requireRedis,
      initialized: queueHealth.initialized,
      initError: queueHealth.initError,
    },
    issues,
    warnings,
    timestamp: nowIso(),
  };
}

function mapCourierBreakRow(row) {
  if (!row) return null;
  return { id: row.id, courierId: row.courier_id, startedAt: row.started_at, endedAt: row.ended_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function getCurrentCourierBreak(courierId) {
  return mapCourierBreakRow(db.prepare(`
    SELECT * FROM courier_breaks
    WHERE courier_id = ? AND ended_at IS NULL
    ORDER BY datetime(started_at) DESC
    LIMIT 1
  `).get(courierId));
}

function getCourierBreaks(courierId, limit = 12) {
  return db.prepare(`SELECT * FROM courier_breaks WHERE courier_id = ? ORDER BY datetime(started_at) DESC LIMIT ?`)
    .all(courierId, limit)
    .map(mapCourierBreakRow);
}

function summarizeCourierPackagesForRange(packages, start, end, perPackageFee = null) {
  const result = packages
    .filter((pkg) => countsForCourierPackageFee(pkg))
    .filter((pkg) => isWithinRange(courierPackageFeeTimestamp(pkg), start, end))
    .reduce((summary, pkg) => {
      const amount = normalizeMoney(pkg.orderAmount);
      summary.deliveredCount += 1;
      summary.totalAmount += amount;
      const paymentStatus = normalizePaymentStatus(pkg.paymentStatus, pkg.paymentMethod);
      if (paymentStatus === PAID_ONLINE_PAYMENT_STATUS) {
        summary.paidOnlineAmount += amount;
      }
      if (paymentStatus === CASH_COLLECTED_PAYMENT_STATUS) {
        summary.cashAmount += amount;
      }
      if (paymentStatus === CREDIT_CARD_COLLECTED_PAYMENT_STATUS) summary.creditCardAmount += amount;
      if (paymentStatus === PAYMENT_ISSUE_STATUS) summary.failedCollectionAmount += amount;
      return summary;
    }, {
      deliveredCount: 0,
      totalAmount: 0,
      paidOnlineAmount: 0,
      cashAmount: 0,
      creditCardAmount: 0,
      failedCollectionAmount: 0,
    });
    
  const settings = getSystemSettings();
  const fee = perPackageFee === null ? (Number(settings.courier_per_package_fee) || 0) : normalizeMoney(perPackageFee);
  result.courierEarnings = result.deliveredCount * fee;
  return result;
}

function buildCourierEarningsSummary(packages, perPackageFee = null) {
  const todayStart = rangeStart(0);
  const yesterdayStart = rangeStart(1);
  const sevenDaysStart = rangeStart(6);
  const tomorrowStart = rangeEnd(0);
  return {
    today: summarizeCourierPackagesForRange(packages, todayStart, tomorrowStart, perPackageFee),
    yesterday: summarizeCourierPackagesForRange(packages, yesterdayStart, todayStart, perPackageFee),
    last7Days: summarizeCourierPackagesForRange(packages, sevenDaysStart, tomorrowStart, perPackageFee),
    total: summarizeCourierPackagesForRange(packages, "1970-01-01T00:00:00.000Z", "2999-12-31T23:59:59.999Z", perPackageFee),
  };
}

function buildCourierShiftSummary(courierId) {
  const shifts = getCourierShifts(courierId, 12);
  const plans = getCourierShiftPlans(courierId, 12);
  return {
    currentShift: shifts.find((shift) => !shift.endedAt) || null,
    currentBreak: getCurrentCourierBreak(courierId),
    recentBreaks: getCourierBreaks(courierId, 12),
    recentShifts: shifts,
    shiftPlans: plans,
  };
}

function buildRestaurantPerformance(packages) {
  const todayStart = rangeStart(0);
  const tomorrowStart = rangeEnd(0);
  const todayPackages = packages.filter((pkg) => isWithinRange(pkg.createdAt, todayStart, tomorrowStart));
  const deliveredToday = packages.filter((pkg) => pkg.status === DELIVERED_STATUS && isWithinRange(pkg.deliveredAt || pkg.updatedAt, todayStart, tomorrowStart));
  const failedToday = packages.filter((pkg) => pkg.status === FAILED_STATUS && isWithinRange(pkg.failedAt || pkg.updatedAt, todayStart, tomorrowStart));

  return {
    todayOrderCount: todayPackages.length,
    deliveredTodayCount: deliveredToday.length,
    averageAssignmentMinutes: averageOf(todayPackages.map((pkg) => diffMinutes(pkg.createdAt, pkg.assignedAt))),
    averageDeliveryMinutes: averageOf(deliveredToday.map((pkg) => diffMinutes(pkg.createdAt, pkg.deliveredAt || pkg.updatedAt))),
    failedDeliveryRate: todayPackages.length > 0 ? Number(((failedToday.length / todayPackages.length) * 100).toFixed(1)) : 0,
  };
}

function buildZoneAlerts(zones, packages) {
  return zones.map((zone) => {
    const waiting = packages
      .filter((pkg) => pkg.zone === zone.name && [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(pkg.status))
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
    const oldestWaitingMinutes = waiting[0]
      ? Math.max(0, Math.round((Date.now() - new Date(waiting[0].createdAt).getTime()) / 60000))
      : 0;
    const severity = waiting.length >= 4 || oldestWaitingMinutes >= 15
      ? "critical"
      : waiting.length >= 2 || oldestWaitingMinutes >= 8
        ? "warning"
        : "stable";
    return {
      zone: zone.name,
      waitingCount: waiting.length,
      oldestWaitingMinutes,
      severity,
      message: severity === "critical"
        ? `${zone.name} bolgesinde yogunluk kritik seviyede.`
        : severity === "warning"
          ? `${zone.name} bolgesinde yogunluk artiyor.`
          : `${zone.name} bolgesi dengeli calisiyor.`,
    };
  }).filter((alert) => alert.severity !== "stable");
}

function buildRestaurantIntegrationWizard(req, restaurant, accounts) {
  const current = accounts[0] || null;
  const webhookUrl = `${requestBaseUrl(req)}/api/platform/order`;
  return {
    currentAccountId: current?.id || "",
    currentPlatform: current?.platform || "",
    verificationStatus: current?.verificationStatus || PLATFORM_VERIFICATION_STATUS.PENDING,
    webhookUrl: current
      ? webhookUrl
      : "Platform hesabini kaydedince webhook URL hazir olur.",
    steps: [
      { id: "select_platform", title: "Adim 1", label: "Platform sec", done: Boolean(current?.platform) },
      { id: "credentials", title: "Adim 2", label: "Gerekli bilgileri gir", done: Boolean(current?.externalStoreId) },
      { id: "webhook_secret", title: "Adim 3", label: "Webhook secret kayitli", done: Boolean(current?.hasWebhookSecret || current?.webhookSecret) },
      { id: "first_order", title: "Adim 4", label: "Ilk gercek siparisle dogrula", done: current?.verificationStatus === PLATFORM_VERIFICATION_STATUS.VERIFIED },
      { id: "success", title: "Adim 5", label: "Webhook modu aktif", done: current?.verificationStatus === PLATFORM_VERIFICATION_STATUS.VERIFIED },
    ],
    helpText: restaurant
      ? `${restaurant.name} icin webhook modu aktif. Polling API kapalı — webhook ile sipariş bekleniyor.`
      : "Restoran oturumu acildiginda entegrasyon sihirbazi aktif olur.",
  };
}

function publicMapsConfig() {
  return {
    googleMapsEmbedApiKey: trimmed(process.env.GOOGLE_MAPS_EMBED_API_KEY),
  };
}

const geocodeCache = new Map();

async function geocodeDeliveryAddress(address, proximity = null) {
  const normalizedAddress = trimmed(address);
  if (!normalizedAddress) return null;

  const proximityLatitude = Number(proximity?.latitude);
  const proximityLongitude = Number(proximity?.longitude);
  const hasProximity = coordinatesAreValid(proximityLatitude, proximityLongitude);
  const cacheKey = `${normalizedAddress.toLocaleLowerCase("tr-TR")}|${hasProximity ? `${proximityLatitude.toFixed(3)},${proximityLongitude.toFixed(3)}` : ""}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const endpoint = trimmed(process.env.GEOCODING_API_URL) || "https://nominatim.openstreetmap.org/search";
    const url = new URL(endpoint);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", hasProximity ? "5" : "1");
    url.searchParams.set("countrycodes", trimmed(process.env.GEOCODING_COUNTRY_CODES) || "tr");
    url.searchParams.set("accept-language", "tr");
    if (hasProximity) {
      const latitudeWindow = 0.45;
      const longitudeWindow = 0.55;
      url.searchParams.set("viewbox", [
        proximityLongitude - longitudeWindow,
        proximityLatitude + latitudeWindow,
        proximityLongitude + longitudeWindow,
        proximityLatitude - latitudeWindow,
      ].join(","));
      url.searchParams.set("bounded", "1");
    }
    url.searchParams.set("q", normalizedAddress);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": trimmed(process.env.GEOCODING_USER_AGENT) || "RESTOMAP/1.0 (delivery address preview)",
      },
    });
    if (!response.ok) return null;
    const results = await response.json();
    let validResults = (Array.isArray(results) ? results : [])
      .map((item) => ({ latitude: Number(item?.lat), longitude: Number(item?.lon) }))
      .filter((item) => coordinatesAreValid(item.latitude, item.longitude));
    if (hasProximity) {
      const maximumDistanceKm = Math.max(1, Number(process.env.GEOCODING_MAX_DISTANCE_KM || 50));
      validResults = validResults.filter((item) =>
        distance(proximityLatitude, proximityLongitude, item.latitude, item.longitude) <= maximumDistanceKm
      );
    }
    const result = hasProximity
      ? validResults.sort((left, right) =>
        distance(proximityLatitude, proximityLongitude, left.latitude, left.longitude) -
        distance(proximityLatitude, proximityLongitude, right.latitude, right.longitude)
      )[0] || null
      : validResults[0] || null;
    if (result) geocodeCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (error?.name !== "AbortError") {
      logger.warn("delivery_address_geocode_failed", { address: normalizedAddress, error: error?.message || String(error) });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildCourierWorkspace(courierId, options = {}) {
  const courier = getCourierById(courierId);
  if (!courier) {
    return null;
  }

  const pagination = options.pagination || { limit: DEFAULT_PAGE_LIMIT, offset: 0 };
  const packages = getCourierPackages(courierId, pagination);
  const activeLoad = packages.filter((item) => isCapacityBlockingPackage(item)).length;
  const poolPackages = getCourierPoolPackages(courierId, 100);
  const historyPackages = getCourierHistoryPackages(courierId);
  const deliveredPackages = mapPackageRowsWithRestaurants(db.prepare(`
    SELECT * FROM packages
    WHERE assigned_courier_id = ? AND status IN (?, ?)
    ORDER BY datetime(COALESCE(delivered_at, updated_at, created_at)) DESC
  `).all(courierId, DELIVERED_STATUS, CANCELED_STATUS)).filter(countsForCourierPackageFee);
  const packagesPagination = pageMeta(countTable("packages", "assigned_courier_id = ?", [courierId]), pagination);
  const todayPackages = deliveredPackagesForCourierOnDate(courierId, dayKey());
  const daySummary = summarizeCourierDay(todayPackages);
  const dayReport = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(courierId, dayKey());
  const visibleDaySummary = dayReport ? summarizeCourierDay([]) : daySummary;
  return {
    courier: {
      ...sanitizeCourier(courier),
      activeLoad,
    },
    packages,
    poolPackages,
    poolCapacity: COURIER_POOL_MAX_ACTIVE_PACKAGES,
    poolAvailableSlots: activeLoad >= 1
      ? Math.max(0, COURIER_POOL_MAX_ACTIVE_PACKAGES - activeLoad)
      : 0,
    historyPackages,
    dayMetrics: {
      reportDate: dayKey(),
      deliveredCount: visibleDaySummary.deliveredCount,
      totalAmount: Number(visibleDaySummary.totalAmount.toFixed(2)),
      paidOnlineAmount: Number(visibleDaySummary.paidOnlineAmount.toFixed(2)),
      cashCollectedAmount: Number(visibleDaySummary.cashCollectedAmount.toFixed(2)),
      creditCardAmount: Number(visibleDaySummary.creditCardAmount.toFixed(2)),
      restaurantCollectedAmount: Number(visibleDaySummary.restaurantCollectedAmount.toFixed(2)),
      failedCollectionTotal: Number(visibleDaySummary.failedCollectionTotal.toFixed(2)),
      hasClosedDay: Boolean(dayReport),
      closedAt: dayReport?.updated_at || null,
      closedSummary: dayReport ? mapCourierDailyReportRow(dayReport) : null,
    },
    earningsSummary: buildCourierEarningsSummary(deliveredPackages, defaultCourierPackageFee(courier)),
    reportSummary: buildCourierReportSummary(historyPackages),
    shiftSummary: buildCourierShiftSummary(courierId),
    shiftPlans: getCourierShiftPlans(courierId, 30),
    managementRecords: getManagementRecords({ subjectType: "courier", subjectId: courierId }),
    notifications: getNotifications("courier", courierId, 20),
    courierDailyReports: getCourierDailyReports(1000, courierId),
    announcements: getAnnouncements("courier"),
    mapsConfig: publicMapsConfig(),
    pagination: {
      packages: packagesPagination,
    },
  };
}

function getWebhookLogs(limit = 20, filter = {}) {
  const offset = parsePositiveInteger(filter.offset, 0);
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM webhook_logs WHERE restaurant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(filter.restaurantId, limit, offset)
    : db.prepare("SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurant_id,
    sourcePlatform: row.source_platform,
    provider: row.provider,
    platform: row.platform || row.source_platform,
    externalRestaurantId: row.external_restaurant_id,
    externalOrderNo: row.external_order_no,
    externalOrderId: row.external_order_id || row.external_order_no,
    signatureValid: Boolean(row.signature_valid),
    isMatched: row.is_matched === null || row.is_matched === undefined ? null : Boolean(row.is_matched),
    status: row.status,
    responseStatus: row.response_status,
    httpStatus: row.http_status || row.response_status,
    errorMessage: row.error_message || row.last_error,
    requestBody: row.request_body,
    rawPayload: parseJson(row.raw_payload, null),
    ipAddress: row.ip_address,
    retryCount: row.retry_count || 0,
    nextRetryAt: row.next_retry_at,
    deadLetteredAt: row.dead_lettered_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  }));
}

function dayKey(value = nowIso()) {
  return String(value).slice(0, 10);
}

const RESTAURANT_REPORT_TIME_ZONE = "Europe/Istanbul";

function restaurantReportDayKey(value = nowIso()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RESTAURANT_REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function restaurantReportDateExpression(column = "created_at") {
  return dbFacade.clientName() === "postgres"
    ? `TO_CHAR(NULLIF(${column}::text, '')::timestamptz AT TIME ZONE '${RESTAURANT_REPORT_TIME_ZONE}', 'YYYY-MM-DD')`
    : `DATE(${column}, '+3 hours')`;
}

function restaurantReportPaymentBucket(paymentMethod, paymentStatus) {
  const methodCode = normalizePaymentMethodCode(paymentMethod);
  const statusCode = normalizePaymentStatus(paymentStatus, paymentMethod);
  if (methodCode === "cash_on_delivery" || [CASH_EXPECTED_PAYMENT_STATUS, CASH_COLLECTED_PAYMENT_STATUS].includes(statusCode)) return "cash";
  if (methodCode === "card_on_delivery" || [CREDIT_CARD_PAYMENT_STATUS, CREDIT_CARD_COLLECTED_PAYMENT_STATUS].includes(statusCode)) return "card";
  if (methodCode === "paid_online" || statusCode === PAID_ONLINE_PAYMENT_STATUS) return "online";
  if (methodCode === "restaurant_collected" || statusCode === RESTAURANT_COLLECTED_PAYMENT_STATUS) return "restaurant";
  return "other";
}

function accountReportWeekRange(dateKey) {
  const selected = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(selected.getTime())) return { startDate: dateKey, endDate: dateKey };
  const mondayOffset = (selected.getUTCDay() + 6) % 7;
  const start = new Date(selected);
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function emptyAccountReportSummary(date, period = "day") {
  return {
    date,
    period,
    totalOrders: 0,
    deliveredCount: 0,
    cancelledCount: 0,
    activeCount: 0,
    failedCount: 0,
    deliveredRevenue: 0,
    cancelledAmount: 0,
    cashCount: 0,
    cashAmount: 0,
    cardCount: 0,
    cardAmount: 0,
    onlineCount: 0,
    onlineAmount: 0,
    restaurantCount: 0,
    restaurantAmount: 0,
    otherCount: 0,
    otherAmount: 0,
  };
}

function mergeAccountReportSummary(target, source) {
  for (const key of [
    "totalOrders", "deliveredCount", "cancelledCount", "activeCount", "failedCount",
    "cashCount", "cardCount", "onlineCount", "restaurantCount", "otherCount",
  ]) target[key] += Number(source[key] || 0);
  for (const key of [
    "deliveredRevenue", "cancelledAmount", "cashAmount", "cardAmount", "onlineAmount",
    "restaurantAmount", "otherAmount",
  ]) target[key] = normalizeMoney(target[key] + Number(source[key] || 0));
  return target;
}

function buildAccountOrderReport({ restaurantId = "", requestedDate, period = "day", startDate = "", endDate = "", statusFilter = "all", paymentFilter = "all" }) {
  const selectedRange = period === "range"
    ? { startDate, endDate }
    : period === "week"
      ? accountReportWeekRange(requestedDate)
      : { startDate: requestedDate, endDate: requestedDate };
  const reportDateExpr = restaurantReportDateExpression("created_at");
  const scopeSql = restaurantId ? "WHERE restaurant_id = ?" : "";
  const scopeParams = restaurantId ? [restaurantId] : [];
  const aggregateRows = db.prepare(`
    SELECT
      ${reportDateExpr} AS report_date,
      status,
      payment_method,
      payment_status,
      COUNT(*) AS package_count,
      SUM(COALESCE(order_amount, 0)) AS total_amount
    FROM packages
    ${scopeSql}
    GROUP BY ${reportDateExpr}, status, payment_method, payment_status
    ORDER BY report_date DESC
  `).all(...scopeParams);

  const byDate = new Map();
  for (const row of aggregateRows) {
    const date = trimmed(row.report_date);
    if (!date) continue;
    const summary = byDate.get(date) || emptyAccountReportSummary(date);
    const count = Number(row.package_count || 0);
    const amount = normalizeMoney(row.total_amount);
    const status = normalizeStatus(row.status);
    const isCancelled = status === CANCELED_STATUS || status === REJECTED_STATUS;
    const isDelivered = status === DELIVERED_STATUS;
    const isFailed = status === FAILED_STATUS;
    summary.totalOrders += count;
    if (isDelivered) {
      summary.deliveredCount += count;
      summary.deliveredRevenue = normalizeMoney(summary.deliveredRevenue + amount);
    } else if (isCancelled) {
      summary.cancelledCount += count;
      summary.cancelledAmount = normalizeMoney(summary.cancelledAmount + amount);
    } else if (isFailed) summary.failedCount += count;
    else summary.activeCount += count;
    if (!isCancelled) {
      const bucket = restaurantReportPaymentBucket(row.payment_method, row.payment_status);
      summary[`${bucket}Count`] += count;
      summary[`${bucket}Amount`] = normalizeMoney(summary[`${bucket}Amount`] + amount);
    }
    byDate.set(date, summary);
  }

  const summary = emptyAccountReportSummary(selectedRange.startDate, period);
  for (const [date, daySummary] of byDate) {
    if (date >= selectedRange.startDate && date <= selectedRange.endDate) mergeAccountReportSummary(summary, daySummary);
  }
  const packageDateExpr = restaurantReportDateExpression("p.created_at");
  const rangeSql = `${packageDateExpr} BETWEEN ? AND ?`;
  const rawPackages = db.prepare(`
    SELECT
      p.id, p.tracking_no, COALESCE(r.name, 'Isletme') AS restaurant_name,
      p.recipient, p.phone, p.address, p.delivery_address, p.customer_address,
      p.assigned_courier_name, p.payment_method, p.payment_status, p.order_amount,
      p.source, p.source_platform, p.external_order_no, p.status,
      p.created_at, p.updated_at, p.delivered_at, p.failed_at
    FROM packages p
    LEFT JOIN restaurants r ON r.id = p.restaurant_id
    WHERE ${restaurantId ? "p.restaurant_id = ? AND " : ""}${rangeSql}
    ORDER BY p.created_at DESC
    LIMIT 10000
  `).all(...scopeParams, selectedRange.startDate, selectedRange.endDate);

  const matchesStatus = (status) => {
    const normalized = normalizeStatus(status);
    if (statusFilter === "all") return true;
    if (statusFilter === "cancelled") return normalized === CANCELED_STATUS || normalized === REJECTED_STATUS;
    if (statusFilter === "delivered") return normalized === DELIVERED_STATUS;
    if (statusFilter === "failed") return normalized === FAILED_STATUS;
    return ![DELIVERED_STATUS, CANCELED_STATUS, REJECTED_STATUS, FAILED_STATUS].includes(normalized);
  };
  const packages = rawPackages
    .filter((pkg) => matchesStatus(pkg.status))
    .filter((pkg) => paymentFilter === "all" || restaurantReportPaymentBucket(pkg.payment_method, pkg.payment_status) === paymentFilter)
    .map((pkg) => ({
      id: pkg.id,
      trackingNo: pkg.tracking_no,
      restaurantName: pkg.restaurant_name || "Isletme",
      customerName: pkg.recipient || "Musteri",
      phone: pkg.phone || "",
      deliveryAddress: pkg.delivery_address || pkg.customer_address || pkg.address || "",
      courierName: pkg.assigned_courier_name || "Atanmadi",
      paymentMethod: pkg.payment_method || "Belirtilmedi",
      paymentStatus: pkg.payment_status || "",
      paymentBucket: restaurantReportPaymentBucket(pkg.payment_method, pkg.payment_status),
      orderAmount: normalizeMoney(pkg.order_amount),
      sourcePlatform: pkg.source_platform || pkg.source || "Telefon",
      status: normalizeStatus(pkg.status),
      createdAt: pkg.created_at,
      deliveredAt: pkg.delivered_at,
      failedAt: pkg.failed_at,
    }));

  let history;
  if (period === "week") {
    const byWeek = new Map();
    for (const daySummary of byDate.values()) {
      const range = accountReportWeekRange(daySummary.date);
      const weekly = byWeek.get(range.startDate) || { ...emptyAccountReportSummary(range.startDate, "week"), endDate: range.endDate };
      mergeAccountReportSummary(weekly, daySummary);
      byWeek.set(range.startDate, weekly);
    }
    history = [...byWeek.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 52);
  } else {
    history = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
    if (period === "range") history = history.filter((item) => item.date >= selectedRange.startDate && item.date <= selectedRange.endDate);
    else history = history.slice(0, 180);
  }

  return {
    ok: true,
    timezone: RESTAURANT_REPORT_TIME_ZONE,
    currentDate: restaurantReportDayKey(),
    selectedDate: period === "range" ? selectedRange.startDate : requestedDate,
    period,
    rangeStart: selectedRange.startDate,
    rangeEnd: selectedRange.endDate,
    filters: { status: statusFilter, payment: paymentFilter },
    summary,
    history,
    packages,
  };
}

function deliveredPackagesForCourierOnDate(courierId, reportDate = dayKey()) {
  const excludedApprovedPackagesSql = dbFacade.clientName() === "postgres"
    ? `SELECT package_item.value #>> '{}'
       FROM courier_daily_reports
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NULLIF(courier_daily_reports.package_ids_json, ''), '[]')::jsonb) AS package_item(value)
       WHERE courier_id = ? AND status = 'approved'`
    : `SELECT value
       FROM courier_daily_reports, json_each(courier_daily_reports.package_ids_json)
       WHERE courier_id = ? AND status = 'approved'`;
  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE assigned_courier_id = ?
      AND status = ?
      AND substr(COALESCE(delivered_at, updated_at, created_at), 1, 10) = ?
      AND id NOT IN (${excludedApprovedPackagesSql})
    ORDER BY datetime(COALESCE(delivered_at, updated_at, created_at)) DESC
  `).all(courierId, DELIVERED_STATUS, reportDate, courierId);
  const restaurantIds = [...new Set(rows.map((row) => row.restaurant_id))];
  const restaurantMap = new Map(
    restaurantIds.map((restaurantId) => {
      const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(restaurantId);
      return [restaurantId, restaurant?.name || "Bilinmeyen Restoran"];
    })
  );
  const platformOrderLookup = buildPlatformOrderLookup(rows);
  return rows.map((row) => mapPackageRow(row, restaurantMap, platformOrderLookup(row)));
}

function paymentAccountingBucket(pkg) {
  const paymentStatus = normalizePaymentStatus(pkg.paymentStatus, pkg.paymentMethod);
  const paymentMethod = trimmed(pkg.paymentMethod).toLowerCase();

  if (paymentStatus === PAYMENT_ISSUE_STATUS) {
    return "issue";
  }
  if (paymentStatus === CASH_COLLECTED_PAYMENT_STATUS) {
    return "cash";
  }
  if (paymentStatus === CREDIT_CARD_COLLECTED_PAYMENT_STATUS) {
    return "card";
  }
  if (paymentStatus === RESTAURANT_COLLECTED_PAYMENT_STATUS || paymentMethod.includes("restoran")) {
    return "restaurant";
  }
  if (paymentStatus === COLLECTED_PAYMENT_STATUS) {
    return normalizeCollectedBy(paymentStatus, pkg.paymentCollectedBy) === "courier" ? "cash" : "restaurant";
  }
  if (paymentStatus === PAID_ONLINE_PAYMENT_STATUS || paymentMethod.includes("online")) {
    return "online";
  }
  if ([CASH_EXPECTED_PAYMENT_STATUS, CREDIT_CARD_PAYMENT_STATUS, UNPAID_PAYMENT_STATUS].includes(paymentStatus)) {
    return "outstanding";
  }
  return "unknown";
}

function summarizeCourierDay(packages) {
  return packages.reduce((summary, pkg) => {
    const amount = normalizeMoney(pkg.orderAmount);
    const bucket = paymentAccountingBucket(pkg);
    summary.deliveredCount += 1;
    summary.totalAmount += amount;
    if (bucket === "online") {
      summary.paidOnlineAmount += amount;
    }
    if (bucket === "restaurant") {
      summary.restaurantCollectedAmount += amount;
    }
    if (bucket === "cash") {
      summary.cashCollectedAmount += amount;
    }
    if (bucket === "card") {
      summary.creditCardAmount += amount;
    }
    if ([CASH_COLLECTED_PAYMENT_STATUS, CREDIT_CARD_COLLECTED_PAYMENT_STATUS, PAID_ONLINE_PAYMENT_STATUS, RESTAURANT_COLLECTED_PAYMENT_STATUS, COLLECTED_PAYMENT_STATUS].includes(normalizePaymentStatus(pkg.paymentStatus, pkg.paymentMethod))) {
      summary.collectedTotal += amount;
    }
    if (bucket === "issue") {
      summary.failedCollectionTotal += amount;
    }
    summary.packageIds.push(pkg.id);
    return summary;
  }, {
    deliveredCount: 0,
    totalAmount: 0,
    paidOnlineAmount: 0,
    cashCollectedAmount: 0,
    creditCardAmount: 0,
    restaurantCollectedAmount: 0,
    collectedTotal: 0,
    failedCollectionTotal: 0,
    packageIds: [],
  });
}

function mapCourierDailyReportRow(row) {
  return {
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.zone,
    reportDate: row.report_date,
    deliveredCount: Number(row.delivered_count || 0),
    totalAmount: Number(row.total_amount || 0),
    paidOnlineAmount: Number(row.paid_online_amount || 0),
    cashCollectedAmount: Number(row.cash_collected_amount || 0),
    creditCardAmount: Number(row.credit_card_amount || 0),
    restaurantCollectedAmount: Number(row.restaurant_collected_amount || 0),
    collectedTotal: Number(row.collected_total || 0),
    failedCollectionTotal: Number(row.failed_collection_total || 0),
    status: row.status || 'pending_approval',
    courierNote: row.courier_note || "",
    adminNote: row.admin_note || "",
    approvedAt: row.approved_at || null,
    packageIds: parseJson(row.package_ids_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getCourierDailyReports(limit = 50, courierId = "") {
  const rows = courierId
    ? db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? ORDER BY datetime(updated_at) DESC LIMIT ?").all(courierId, limit)
    : db.prepare("SELECT * FROM courier_daily_reports ORDER BY datetime(updated_at) DESC LIMIT ?").all(limit);
  return rows.map(mapCourierDailyReportRow);
}

function getCourierPerformanceReport(dateScope = dayKey()) {
  const allHistory = dateScope === "all";
  const selectedDate = allHistory ? "all" : /^\d{4}-\d{2}-\d{2}$/.test(String(dateScope)) ? String(dateScope) : dayKey();
  const totals = new Map();
  const rows = db.prepare(`
    SELECT assigned_courier_id, status, order_amount, created_at, updated_at, delivered_at, failed_at
    FROM packages
    WHERE assigned_courier_id IS NOT NULL
  `).all();
  for (const row of rows) {
    const eventDate = dayKey(row.delivered_at || row.failed_at || row.updated_at || row.created_at);
    if (!allHistory && eventDate !== selectedDate) continue;
    const summary = totals.get(row.assigned_courier_id) || { totalCount: 0, deliveredCount: 0, deliveredAmount: 0 };
    summary.totalCount += 1;
    if (normalizeStatus(row.status) === DELIVERED_STATUS) {
      summary.deliveredCount += 1;
      summary.deliveredAmount = normalizeMoney(summary.deliveredAmount + Number(row.order_amount || 0));
    }
    totals.set(row.assigned_courier_id, summary);
  }
  return {
    date: selectedDate,
    allHistory,
    couriers: getCouriers().map((courier) => ({
      id: courier.id,
      name: courier.name,
      zone: courier.zone,
      status: courier.status,
      ...(totals.get(courier.id) || { totalCount: 0, deliveredCount: 0, deliveredAmount: 0 }),
    })),
  };
}

function defaultCourierPackageFee(courier) {
  const customFee = Number(courier?.perPackageFee);
  if (Number.isFinite(customFee) && customFee > 0) {
    return normalizeMoney(customFee);
  }
  const settings = getSystemSettings();
  return normalizeMoney(settings.courier_per_package_fee || 0);
}

function deliveredPackagesForCourierEarnings(courierId, reportDate = dayKey()) {
  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE assigned_courier_id = ?
      AND status IN (?, ?)
      AND substr(COALESCE(delivered_at, updated_at, created_at), 1, 10) = ?
    ORDER BY datetime(COALESCE(delivered_at, updated_at, created_at)) DESC
  `).all(courierId, DELIVERED_STATUS, CANCELED_STATUS, reportDate);
  return mapPackageRowsWithRestaurants(rows).filter(countsForCourierPackageFee);
}

function mapCourierEarningItemRow(row, packageRow = null) {
  const pkg = packageRow || (row.package_id ? getPackageById(row.package_id) : null);
  return {
    id: row.id,
    courierEarningId: row.courier_earning_id,
    packageId: row.package_id,
    restaurantId: row.restaurant_id,
    restaurantName: pkg?.restaurantName || row.restaurant_name || "",
    deliveredAt: row.delivered_at,
    packageFee: Number(row.package_fee || 0),
    package: pkg ? {
      id: pkg.id,
      trackingNo: pkg.trackingNo,
      restaurantId: pkg.restaurantId,
      restaurantName: pkg.restaurantName,
      customerName: pkg.recipient,
      deliveryAddress: pkg.deliveryAddress || pkg.address || pkg.customerAddress,
      orderAmount: pkg.orderAmount,
      paymentMethod: pkg.paymentMethod,
      deliveredAt: pkg.deliveredAt,
      status: pkg.status,
      failureReason: pkg.failureReason || "",
      courierNote: pkg.courierCollectionNote || pkg.customerNote || pkg.note || "",
    } : null,
    createdAt: row.created_at,
  };
}

function getCourierEarningItems(earningId) {
  const rows = db.prepare("SELECT * FROM courier_earning_items WHERE courier_earning_id = ? ORDER BY datetime(delivered_at) DESC").all(earningId);
  if (!rows.length) return [];
  const packageIds = rows.map((row) => row.package_id);
  const placeholders = packageIds.map(() => "?").join(",");
  const packageRows = db.prepare(`SELECT * FROM packages WHERE id IN (${placeholders})`).all(...packageIds);
  const packageMap = new Map(mapPackageRowsWithRestaurants(packageRows).map((pkg) => [pkg.id, pkg]));
  return rows.map((row) => mapCourierEarningItemRow(row, packageMap.get(row.package_id)));
}

function mapCourierEarningRow(row, options = {}) {
  const courier = row.courier_id ? getCourierById(row.courier_id) : null;
  const items = options.includeItems ? getCourierEarningItems(row.id) : undefined;
  return {
    id: row.id,
    courierId: row.courier_id,
    courierName: courier?.name || row.courier_name || "Bilinmeyen Kurye",
    reportDate: row.report_date,
    deliveredPackageCount: Number(row.delivered_package_count || 0),
    perPackageFee: Number(row.per_package_fee || 0),
    bonusAmount: Number(row.bonus_amount || 0),
    deductionAmount: Number(row.deduction_amount || 0),
    totalPayable: Number(row.total_payable || 0),
    paymentStatus: row.payment_status || "unpaid",
    paidAt: row.paid_at || null,
    adminNote: row.admin_note || "",
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recalculateCourierEarningTotal(count, fee, bonus = 0, deduction = 0) {
  return normalizeMoney((Number(count || 0) * normalizeMoney(fee)) + normalizeMoney(bonus) - normalizeMoney(deduction));
}

function syncCourierEarning(courierId, reportDate = dayKey(), options = {}) {
  const courier = getCourierById(courierId);
  if (!courier) {
    throw httpError(404, "Kurye bulunamadi.");
  }
  const packages = deliveredPackagesForCourierEarnings(courierId, reportDate);
  const existing = db.prepare("SELECT * FROM courier_earnings WHERE courier_id = ? AND report_date = ?").get(courierId, reportDate);
  const stamp = nowIso();
  const perPackageFee = options.perPackageFee !== undefined && options.perPackageFee !== ""
    ? normalizeMoney(options.perPackageFee)
    : normalizeMoney(existing?.per_package_fee || defaultCourierPackageFee(courier));
  const datedAdjustments = getManagementRecords({ recordType: "courier_adjustment", subjectId: courierId, status: "active" })
    .filter((item) => !item.startDate || item.startDate === reportDate);
  const recordedBonus = datedAdjustments.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
  const recordedDeduction = Math.abs(datedAdjustments.filter((item) => item.amount < 0).reduce((sum, item) => sum + item.amount, 0));
  const bonusAmount = options.bonusAmount !== undefined ? normalizeMoney(options.bonusAmount) : normalizeMoney(existing?.bonus_amount || recordedBonus);
  const deductionAmount = options.deductionAmount !== undefined ? normalizeMoney(options.deductionAmount) : normalizeMoney(existing?.deduction_amount || recordedDeduction);
  const totalPayable = recalculateCourierEarningTotal(packages.length, perPackageFee, bonusAmount, deductionAmount);
  const status = existing?.payment_status || "unpaid";
  const adminNote = options.adminNote !== undefined ? trimmed(options.adminNote) : (existing?.admin_note || "");
  const earningId = existing?.id || uid("earn");

  if (existing) {
    if (existing.payment_status === "paid" && !trimmed(options.adminNote)) {
      throw httpError(400, "Odendi durumundaki hakedisi guncellemek icin admin notu zorunludur.");
    }
    db.prepare(`
      UPDATE courier_earnings
      SET delivered_package_count = ?, per_package_fee = ?, bonus_amount = ?, deduction_amount = ?, total_payable = ?, admin_note = ?, updated_at = ?
      WHERE id = ?
    `).run(packages.length, perPackageFee, bonusAmount, deductionAmount, totalPayable, adminNote, stamp, earningId);
  } else {
    db.prepare(`
      INSERT INTO courier_earnings (
        id, courier_id, report_date, delivered_package_count, per_package_fee, bonus_amount,
        deduction_amount, total_payable, payment_status, paid_at, admin_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(earningId, courierId, reportDate, packages.length, perPackageFee, bonusAmount, deductionAmount, totalPayable, status, null, adminNote, stamp, stamp);
  }

  db.prepare("DELETE FROM courier_earning_items WHERE courier_earning_id = ?").run(earningId);
  const insertItem = db.prepare(`
    INSERT INTO courier_earning_items (id, courier_earning_id, package_id, restaurant_id, delivered_at, package_fee, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  packages.forEach((pkg) => {
    insertItem.run(uid("earni"), earningId, pkg.id, pkg.restaurantId, pkg.deliveredAt || pkg.updatedAt || pkg.createdAt, perPackageFee, stamp);
  });

  return getCourierEarningById(earningId);
}

function getCourierEarningById(earningId) {
  const row = db.prepare("SELECT * FROM courier_earnings WHERE id = ?").get(earningId);
  if (!row) {
    throw httpError(404, "Hak edis kaydi bulunamadi.");
  }
  return mapCourierEarningRow(row, { includeItems: true });
}

function getCourierEarnings(filters = {}) {
  const where = [];
  const params = [];
  if (filters.date) {
    where.push("e.report_date = ?");
    params.push(filters.date);
  }
  if (filters.courierId) {
    where.push("e.courier_id = ?");
    params.push(filters.courierId);
  }
  if (filters.paymentStatus) {
    where.push("e.payment_status = ?");
    params.push(filters.paymentStatus);
  }
  if (filters.restaurantId) {
    where.push("EXISTS (SELECT 1 FROM courier_earning_items cei WHERE cei.courier_earning_id = e.id AND cei.restaurant_id = ?)");
    params.push(filters.restaurantId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    SELECT e.*
    FROM courier_earnings e
    ${whereSql}
    ORDER BY datetime(e.report_date) DESC, datetime(e.updated_at) DESC
    LIMIT 200
  `).all(...params).map((row) => mapCourierEarningRow(row, { includeItems: true }));
}

function generateCourierEarnings({ date = dayKey(), courierId = "", perPackageFee, adminNote = "" } = {}) {
  const couriers = courierId ? [getCourierById(courierId)].filter(Boolean) : getCouriers();
  if (courierId && !couriers.length) {
    throw httpError(404, "Kurye bulunamadi.");
  }
  return couriers.map((courier) => syncCourierEarning(courier.id, date, { perPackageFee, adminNote }));
}

function updateCourierEarning(earningId, body = {}) {
  const current = db.prepare("SELECT * FROM courier_earnings WHERE id = ?").get(earningId);
  if (!current) {
    throw httpError(404, "Hak edis kaydi bulunamadi.");
  }
  const adminNote = trimmed(body.adminNote ?? current.admin_note);
  if (current.payment_status === "paid" && !adminNote) {
    throw httpError(400, "Odendi durumundaki hakedisi guncellemek icin admin notu zorunludur.");
  }
  return syncCourierEarning(current.courier_id, current.report_date, {
    perPackageFee: body.perPackageFee ?? current.per_package_fee,
    bonusAmount: body.bonusAmount ?? current.bonus_amount,
    deductionAmount: body.deductionAmount ?? current.deduction_amount,
    adminNote,
  });
}

function markCourierEarningPaid(earningId, body = {}) {
  const current = db.prepare("SELECT * FROM courier_earnings WHERE id = ?").get(earningId);
  if (!current) {
    throw httpError(404, "Hak edis kaydi bulunamadi.");
  }
  const stamp = body.paidAt ? new Date(body.paidAt).toISOString() : nowIso();
  db.prepare(`
    UPDATE courier_earnings
    SET payment_status = 'paid', paid_at = ?, admin_note = COALESCE(NULLIF(?, ''), admin_note), updated_at = ?
    WHERE id = ?
  `).run(stamp, trimmed(body.adminNote), nowIso(), earningId);
  return getCourierEarningById(earningId);
}

function upsertCourierDailyReport(courierId, reportDate = dayKey(), options = {}) {
  const courier = getCourierById(courierId);
  if (!courier) {
    throw httpError(404, "Kurye bulunamadi.");
  }

  const packages = deliveredPackagesForCourierOnDate(courierId, reportDate);
  const summary = summarizeCourierDay(packages);
  const existing = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(courierId, reportDate);
  const stamp = nowIso();

  if (existing) {
    db.prepare(`
      UPDATE courier_daily_reports
      SET courier_name = ?, zone = ?, delivered_count = ?, total_amount = ?, paid_online_amount = ?, cash_collected_amount = ?, credit_card_amount = ?,
          restaurant_collected_amount = ?, collected_total = ?, failed_collection_total = ?, courier_note = ?, status = 'pending_approval', package_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      courier.name,
      courier.zone,
      summary.deliveredCount,
      Number(summary.totalAmount.toFixed(2)),
      Number(summary.paidOnlineAmount.toFixed(2)),
      Number(summary.cashCollectedAmount.toFixed(2)),
      Number(summary.creditCardAmount.toFixed(2)),
      Number(summary.restaurantCollectedAmount.toFixed(2)),
      Number(summary.collectedTotal.toFixed(2)),
      Number(summary.failedCollectionTotal.toFixed(2)),
      trimmed(options.courierNote) || existing.courier_note || "",
      json(summary.packageIds),
      stamp,
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO courier_daily_reports (
        id, courier_id, courier_name, zone, report_date, delivered_count, total_amount, paid_online_amount,
        cash_collected_amount, credit_card_amount, restaurant_collected_amount, collected_total, failed_collection_total, courier_note, package_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid("cdr"),
      courierId,
      courier.name,
      courier.zone,
      reportDate,
      summary.deliveredCount,
      Number(summary.totalAmount.toFixed(2)),
      Number(summary.paidOnlineAmount.toFixed(2)),
      Number(summary.cashCollectedAmount.toFixed(2)),
      Number(summary.creditCardAmount.toFixed(2)),
      Number(summary.restaurantCollectedAmount.toFixed(2)),
      Number(summary.collectedTotal.toFixed(2)),
      Number(summary.failedCollectionTotal.toFixed(2)),
      trimmed(options.courierNote),
      json(summary.packageIds),
      stamp,
      stamp
    );
  }

  const savedReport = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(courierId, reportDate);
  return mapCourierDailyReportRow(savedReport);
}

function currentState(filter = {}) {
  return {
    zones: getZones(),
    restaurants: getRestaurants({ restaurantId: filter.restaurantId }),
    couriers: getCouriers(),
    packages: getPackages(filter),
    platformAccounts: getPlatformAccounts(filter),
    platformOrders: getPlatformOrders(filter),
    webhookLogs: getWebhookLogs(20, filter),
    platformEvents: getPlatformEvents(20, filter),
  };
}

function activeAssignmentsForCourier(packages, courierId, excludePackageId = null) {
  return packages.filter((item) =>
    item.assignedCourierId === courierId &&
    item.id !== excludePackageId &&
    isCapacityBlockingPackage(item)
  ).length;
}

function sameRestaurantContinuationForCourier(packages, courierId, pkg, excludePackageId = null) {
  if (!courierId || !pkg?.restaurantId) {
    return false;
  }
  const activeAssignments = packages.filter((item) =>
    item.assignedCourierId === courierId &&
    item.id !== excludePackageId &&
    isCapacityBlockingPackage(item)
  );
  if (activeAssignments.length !== AUTO_SAME_RESTAURANT_MAX_ACTIVE_PACKAGES - 1) {
    return false;
  }
  const existingPackage = activeAssignments[0];
  return existingPackage.restaurantId === pkg.restaurantId &&
    [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(normalizeStatus(existingPackage.status));
}

function buildActiveLoadMap(packages, excludePackageId = null) {
  const loadMap = new Map();
  packages.forEach((item) => {
    if (!item.assignedCourierId || item.id === excludePackageId || !isCapacityBlockingPackage(item)) {
      return;
    }
    loadMap.set(item.assignedCourierId, (loadMap.get(item.assignedCourierId) || 0) + 1);
  });
  return loadMap;
}

function isCourierOfferExpired(pkg, referenceTime = Date.now()) {
  return normalizeStatus(pkg?.status) === ASSIGNED_STATUS &&
    pkg?.assignedAt &&
    referenceTime - new Date(pkg.assignedAt).getTime() >= COURIER_OFFER_TIMEOUT_MS;
}

function isCapacityBlockingPackage(pkg) {
  if (!isActivePackageStatus(pkg?.status)) {
    return false;
  }
  return !isCourierOfferExpired(pkg);
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distance(aLat, aLng, bLat, bLng) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

function courierLocationIsFresh(courier, referenceTime = Date.now()) {
  const locationTime = new Date(courier?.lastLocationAt || "").getTime();
  if (!Number.isFinite(locationTime)) {
    return false;
  }
  const ageMs = referenceTime - locationTime;
  return ageMs >= -60_000 && ageMs <= COURIER_LOCATION_FRESHNESS_MS;
}

function courierBackgroundLocationIsUsable(courier, referenceTime = Date.now()) {
  const locationTime = new Date(courier?.lastLocationAt || "").getTime();
  const ageMs = referenceTime - locationTime;
  return Boolean(courier?.id)
    && Boolean(courier?.available)
    && coordinatesAreValid(Number(courier?.latitude), Number(courier?.longitude))
    && Number.isFinite(locationTime)
    && ageMs >= -60_000
    && ageMs <= COURIER_BACKGROUND_LOCATION_MAX_AGE_MS
    && Boolean(getOpenCourierShift(courier.id));
}

function courierLocationIsAssignmentUsable(courier, referenceTime = Date.now()) {
  return courierLocationIsFresh(courier, referenceTime)
    || courierBackgroundLocationIsUsable(courier, referenceTime);
}

function liveMapCouriers(referenceTime = Date.now(), options = {}) {
  const includeBackground = options.includeBackground === true;
  return getCouriers().filter((courier) => {
    const status = normalizeCourierStatus(courier.status, courier.available);
    const locationAgeMs = referenceTime - new Date(courier.lastLocationAt || "").getTime();
    const locationFresh = locationAgeMs >= -60_000 && locationAgeMs <= COURIER_LIVE_LOCATION_FRESHNESS_MS;
    return Boolean(courier.available)
      && [COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(status)
      && (locationFresh || (includeBackground && courierBackgroundLocationIsUsable(courier, referenceTime)));
  }).map((courier) => {
    const locationAgeMs = referenceTime - new Date(courier.lastLocationAt || "").getTime();
    const locationFresh = locationAgeMs >= -60_000 && locationAgeMs <= COURIER_LIVE_LOCATION_FRESHNESS_MS;
    return {
      ...courier,
      locationFresh,
      locationSource: locationFresh ? "live" : "last_known",
      locationAgeSeconds: Math.max(0, Math.round(locationAgeMs / 1000)),
    };
  });
}

function buildCourierFairnessMap(packages) {
  const today = dayKey();
  const fairnessMap = new Map();
  packages.forEach((item) => {
    if (!item.assignedCourierId || !item.assignedAt) {
      return;
    }
    const current = fairnessMap.get(item.assignedCourierId) || {
      todayAssignments: 0,
      lastAssignedAt: 0,
    };
    if (dayKey(item.assignedAt) === today) {
      current.todayAssignments += 1;
    }
    const assignedAt = new Date(item.assignedAt).getTime();
    if (Number.isFinite(assignedAt)) {
      current.lastAssignedAt = Math.max(current.lastAssignedAt, assignedAt);
    }
    fairnessMap.set(item.assignedCourierId, current);
  });
  return fairnessMap;
}

function assignmentTieBreaker(packageId, courierId) {
  const value = `${packageId || ""}:${courierId || ""}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function packageAssignmentCoordinates(state, pkg) {
  const restaurant = state.restaurants.find((item) => item.id === pkg.restaurantId);
  const restaurantLatitude = Number(restaurant?.latitude);
  const restaurantLongitude = Number(restaurant?.longitude);
  if (coordinatesAreValid(restaurantLatitude, restaurantLongitude)) {
    return { latitude: restaurantLatitude, longitude: restaurantLongitude, source: "restaurant_current" };
  }

  const packageLatitude = Number(pkg.latitude);
  const packageLongitude = Number(pkg.longitude);
  if (coordinatesAreValid(packageLatitude, packageLongitude)) {
    return {
      latitude: packageLatitude,
      longitude: packageLongitude,
      source: "package_snapshot",
    };
  }

  const zoneCenters = {
    akdeniz: { latitude: 36.8081, longitude: 34.6372 },
    yenisehir: { latitude: 36.7810, longitude: 34.5740 },
    mezitli: { latitude: 36.7503, longitude: 34.5388 },
    toroslar: { latitude: 36.8241, longitude: 34.6250 },
    tarsus: { latitude: 36.9177, longitude: 34.8928 },
  };
  const zoneKey = String(restaurant?.zone || pkg.zone || "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
  const zoneCenter = zoneCenters[zoneKey];
  if (zoneCenter) {
    return { ...zoneCenter, source: "zone_center_fallback" };
  }

  return {
    latitude: packageLatitude,
    longitude: packageLongitude,
    source: "missing_coordinates",
  };
}

function summarizeCourierDeliveryPerformance(packages, start, end) {
  const delivered = packages
    .filter((pkg) => normalizeStatus(pkg.status) === DELIVERED_STATUS)
    .filter((pkg) => isWithinRange(pkg.deliveredAt || pkg.updatedAt, start, end));
  return {
    deliveredCount: delivered.length,
    averageDeliveryMinutes: averageOf(delivered.map((pkg) => diffMinutes(pkg.acceptedAt || pkg.assignedAt || pkg.createdAt, pkg.deliveredAt || pkg.updatedAt))),
  };
}

function buildCourierReportSummary(packages) {
  const tomorrowStart = rangeEnd(0);
  return {
    daily: summarizeCourierDeliveryPerformance(packages, rangeStart(0), tomorrowStart),
    weekly: summarizeCourierDeliveryPerformance(packages, rangeStart(6), tomorrowStart),
    monthly: summarizeCourierDeliveryPerformance(packages, rangeStart(29), tomorrowStart),
  };
}

function waitingPackagePriority(pkg) {
  return new Date(pkg.createdAt).getTime();
}

function isFreshAutomaticAssignmentCandidate(pkg, referenceTime = Date.now()) {
  const createdAt = new Date(pkg.createdAt).getTime();
  if (!Number.isFinite(createdAt)) {
    return true;
  }
  return referenceTime - createdAt <= AUTOMATIC_ASSIGNMENT_MAX_PACKAGE_AGE_MS;
}

function activeCourierRejectionCooldownIds(referenceTime = Date.now()) {
  if (COURIER_REJECTION_COOLDOWN_MS <= 0) {
    return [];
  }
  const cutoff = new Date(referenceTime - COURIER_REJECTION_COOLDOWN_MS).toISOString();
  return db.prepare(`
    SELECT DISTINCT actor_id
    FROM audit_logs
    WHERE actor_role = 'courier'
      AND action = ?
      AND actor_id IS NOT NULL
      AND created_at >= ?
  `).all("courier_package_rejected", cutoff).map((row) => row.actor_id);
}

function packageRejectionCooldownRemainingMs(packageId, referenceTime = Date.now()) {
  if (!packageId || PACKAGE_REJECTION_COOLDOWN_MS <= 0) {
    return 0;
  }
  const latestRejection = db.prepare(`
    SELECT created_at
    FROM audit_logs
    WHERE action = ? AND package_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get("courier_package_rejected", packageId);
  const rejectedAt = new Date(latestRejection?.created_at || "").getTime();
  if (!Number.isFinite(rejectedAt)) {
    return 0;
  }
  return Math.max(0, PACKAGE_REJECTION_COOLDOWN_MS - (referenceTime - rejectedAt));
}

function reserveCourier(loadMap, courierId, delta) {
  if (!courierId) {
    return;
  }

  const nextValue = (loadMap.get(courierId) || 0) + delta;
  if (nextValue <= 0) {
    loadMap.delete(courierId);
    return;
  }

  loadMap.set(courierId, nextValue);
}

function withImmediateTransaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw error;
  }
}

function isCourierPoolFallbackPackage(pkg, state = null) {
  if (!pkg?.id || pkg.assignedCourierId || ![PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(normalizeStatus(pkg.status))) {
    return false;
  }
  if (!pkg.lastAssignmentAttemptAt || !trimmed(pkg.lastAssignmentError)) {
    return false;
  }
  if (packageRejectionCooldownRemainingMs(pkg.id) > 0) {
    return false;
  }
  const assignmentState = state || {
    restaurants: getRestaurants(),
    couriers: getCouriers(),
    packages: getPackages(),
  };
  return rankEligibleCouriers(assignmentState, pkg).length === 0;
}

function claimCourierPoolPackage(courierId, packageId) {
  const result = withImmediateTransaction(() => {
    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
    if (!courier) throw httpError(404, "Kurye bulunamadi.");

    const courierStatus = normalizeCourierStatus(courier.status, Boolean(courier.available));
    if (!Boolean(courier.available) || ![COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(courierStatus)) {
      throw httpError(409, "Havuzdan paket almak icin kurye aktif ve cevrimici olmalidir.");
    }

    const activeLoad = Number(db.prepare(`
      SELECT COUNT(*) AS total
      FROM packages
      WHERE assigned_courier_id = ?
        AND status IN (?, ?, ?)
    `).get(courierId, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0);
    if (activeLoad >= COURIER_POOL_MAX_ACTIVE_PACKAGES) {
      throw httpError(409, `Kurye havuz kapasitesine ulasti (${COURIER_POOL_MAX_ACTIVE_PACKAGES} aktif paket).`);
    }
    if (activeLoad < 1) {
      throw httpError(409, "Bos kurye icin otomatik atama onceliklidir; havuz yalnizca ikinci paket senaryosunda kullanilir.");
    }

    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    if (!target) throw httpError(404, "Havuz paketi bulunamadi.");
    const targetStatus = normalizeStatus(target.status);
    if (target.assigned_courier_id || ![PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(targetStatus)) {
      throw httpError(409, "Bu paket artik havuzda degil.");
    }

    const mappedTarget = getPackageById(packageId);
    if (!isCourierPoolFallbackPackage(mappedTarget)) {
      throw httpError(409, "Paket otomatik atama sirasinda; uygun bos kurye onceliklidir.");
    }

    const stamp = nowIso();
    const courierCoordinates = coordinatesAreValid(courier.x, courier.y) ? { latitude: Number(courier.x), longitude: Number(courier.y) } : null;
    const restaurantCoordinates = coordinatesAreValid(target.x, target.y) ? { latitude: Number(target.x), longitude: Number(target.y) } : null;
    const distanceKm = courierCoordinates && restaurantCoordinates
      ? Number(distance(courierCoordinates.latitude, courierCoordinates.longitude, restaurantCoordinates.latitude, restaurantCoordinates.longitude).toFixed(2))
      : null;
    if (!Number.isFinite(distanceKm) || distanceKm > MAX_ASSIGNMENT_DISTANCE_KM) {
      throw httpError(409, `Havuz paketi restoranin ${MAX_ASSIGNMENT_DISTANCE_KM} km hizmet siniri disinda.`);
    }
    const update = db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = 'assigned', assigned_courier_id = ?, assigned_courier_name = ?,
          assigned_at = ?, accepted_at = ?, on_route_at = NULL, delivered_at = NULL, failed_at = NULL,
          distance_km = ?, failure_reason = NULL, assignment_reason = ?, last_assignment_attempt_at = ?,
          last_assignment_error = '', updated_at = ?
      WHERE id = ?
        AND assigned_courier_id IS NULL
        AND status IN (?, ?, ?)
    `).run(
      ACCEPTED_BY_COURIER_STATUS,
      courier.id,
      courier.name,
      stamp,
      stamp,
      distanceKm,
      `Kurye havuzdan kendisi aldi (${activeLoad + 1}/${COURIER_POOL_MAX_ACTIVE_PACKAGES}).`,
      stamp,
      stamp,
      packageId,
      PENDING_STATUS,
      PREPARING_STATUS,
      AWAITING_ASSIGNMENT_STATUS
    );
    if (Number(update?.changes || 0) !== 1) {
      throw httpError(409, "Paket baska bir kurye tarafindan alindi.");
    }

    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(COURIER_BUSY_STATUS, courier.id);
    appendTriedCourier(packageId, courier.id);
    return { target, courier, activeLoad: activeLoad + 1 };
  });

  clearAssignmentRetry(packageId);
  const claimedPackage = getPackageById(packageId);
  enqueuePosentegraStatusChange(claimedPackage, ACCEPTED_BY_COURIER_STATUS);
  if (isPlatformBackedPackage(result.target)) {
    notifyPlatformOrderAssigned(result.target.source_platform, result.target.external_order_id || result.target.external_order_no, result.courier.id, claimedPackage);
  }
  return { ...result, claimedPackage };
}

function isAssignableOrderStatus(status) {
  return [PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS].includes(normalizeStatus(status));
}

function clearAssignmentRetry(packageId) {
  const activeTimer = assignmentRetryTimers.get(packageId);
  if (activeTimer) {
    clearTimeout(activeTimer);
    assignmentRetryTimers.delete(packageId);
  }
}

function setPackageTriedCouriers(packageId, courierIds = []) {
  db.prepare("UPDATE packages SET assignment_tried_courier_ids_json = ?, updated_at = ? WHERE id = ?").run(
    json(normalizeIdList(courierIds)),
    nowIso(),
    packageId
  );
}

function appendTriedCourier(packageId, courierId) {
  const target = db.prepare("SELECT assignment_tried_courier_ids_json FROM packages WHERE id = ?").get(packageId);
  const nextIds = normalizeIdList([
    ...normalizeIdList(parseJson(target?.assignment_tried_courier_ids_json, [])),
    courierId,
  ]);
  setPackageTriedCouriers(packageId, nextIds);
  return nextIds;
}

function syncAssignmentRetryForPackage(pkg) {
  if (!pkg?.id) {
    return;
  }
  if (normalizeStatus(pkg.status) !== ASSIGNED_STATUS || !pkg.assignedCourierId) {
    clearAssignmentRetry(pkg.id);
    return;
  }

  clearAssignmentRetry(pkg.id);
  queueService.enqueue(JOB_TYPES.ASSIGNMENT_RETRY, {
    packageId: pkg.id,
    assignedCourierId: pkg.assignedCourierId,
    scheduledAt: nowIso(),
  }, {
    delayMs: COURIER_OFFER_TIMEOUT_MS,
  }).then((result) => {
    if (result.ok) {
      logger.info("Assignment retry queued", { packageId: pkg.id, queueMode: result.mode, jobId: result.jobId });
    }
  });
  const timerId = setTimeout(() => {
    handleAssignmentRetry(pkg.id).catch((error) => {
      logger.error("Assignment retry failed", { packageId: pkg.id, error });
    });
  }, COURIER_OFFER_TIMEOUT_MS);
  assignmentRetryTimers.set(pkg.id, timerId);
}

function buildAssignmentFailure(pkg, reason, note) {
  const currentStatus = normalizeStatus(pkg.status);
  const waitingStatus = currentStatus === PREPARING_STATUS ? PREPARING_STATUS : AWAITING_ASSIGNMENT_STATUS;
  const waitingAssignmentStatus = currentStatus === PREPARING_STATUS ? "waiting_courier" : "pending";
  return {
    ...pkg,
    assignedCourierId: null,
    assignedCourierName: null,
    assignedAt: null,
    distanceKm: null,
    status: waitingStatus,
    assignmentStatus: waitingAssignmentStatus,
    lastAssignmentAttemptAt: nowIso(),
    lastAssignmentError: reason,
    assignmentReason: note,
  };
}

function evaluateAssignmentFailure(state, pkg) {
  const assignmentCoordinates = packageAssignmentCoordinates(state, pkg);
  if (!pkg.restaurantId || !pkg.zone || !coordinatesAreValid(
    assignmentCoordinates.latitude,
    assignmentCoordinates.longitude
  )) {
    return {
      reason: "veri eksik",
      note: "Restoran konumu gecersiz veya eksik oldugu icin kurye atamasi yapilamadi. Admin panelinden restoran konumunu guncelleyin.",
    };
  }

  const restaurantExists = state.restaurants.some((restaurant) => restaurant.id === pkg.restaurantId);
  if (!restaurantExists) {
    return {
      reason: "tenant uyusmuyor",
      note: "Siparisin restoran kaydi bulunamadigi icin tenant dogrulamasi gecemedi.",
    };
  }

  const allCouriers = state.couriers;
  if (allCouriers.length === 0) {
    return {
      reason: "uygun kurye yok",
      note: "Uygun kurye bulunamadi: kayitli kurye yok.",
    };
  }

  const onlineCouriers = allCouriers.filter((courier) =>
    Boolean(courier.available) &&
    [COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(normalizeCourierStatus(courier.status, courier.available))
  );
  if (onlineCouriers.length === 0) {
    return {
      reason: "online kurye yok",
      note: "Uygun kurye bulunamadi: online kurye yok.",
    };
  }

  const usableLocationCouriers = onlineCouriers.filter((courier) => courierLocationIsAssignmentUsable(courier));
  if (usableLocationCouriers.length === 0) {
    return {
      reason: "guncel konum yok",
      note: "Uygun kurye bulunamadi: online kuryelerin acik vardiyada kullanilabilir son konumu yok.",
    };
  }

  const freeOnlineCouriers = usableLocationCouriers.filter((courier) => {
    const activeLoad = activeAssignmentsForCourier(state.packages, courier.id, pkg.id);
    return activeLoad < 1 || (
      activeLoad < AUTO_SAME_RESTAURANT_MAX_ACTIVE_PACKAGES &&
      sameRestaurantContinuationForCourier(state.packages, courier.id, pkg, pkg.id)
    );
  });
  if (freeOnlineCouriers.length === 0) {
    return {
      reason: "tum kuryeler busy",
      note: "Uygun kurye bulunamadi: tum online kuryeler aktif gorevde.",
    };
  }

  return {
    reason: "mesafe disi",
    note: `Uygun kurye bulunamadi: ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde kurye yok.`,
  };
}

function rankEligibleCouriers(state, pkg, occupiedCourierLoads = new Map(), options = {}) {
  const excludedCourierIds = new Set(options.excludedCourierIds || []);
  const cooldownCourierIds = new Set(options.cooldownCourierIds || activeCourierRejectionCooldownIds());
  const activeLoadMap = buildActiveLoadMap(state.packages, pkg.id);
  const fairnessMap = buildCourierFairnessMap(state.packages);
  const assignmentCoordinates = packageAssignmentCoordinates(state, pkg);
  const availableCandidates = state.couriers
    .map((courier) => ({
      courier,
      courierStatus: normalizeCourierStatus(courier.status, courier.available),
      distance: distance(
        courier.latitude,
        courier.longitude,
        assignmentCoordinates.latitude,
        assignmentCoordinates.longitude
      ),
      freshLocation: courierLocationIsFresh(courier),
      load: Math.max(
        occupiedCourierLoads.get(courier.id) || 0,
        activeLoadMap.get(courier.id) || 0
      ),
      sameRestaurantContinuation: sameRestaurantContinuationForCourier(state.packages, courier.id, pkg, pkg.id),
      fairness: fairnessMap.get(courier.id) || { todayAssignments: 0, lastAssignedAt: 0 },
    }))
    .filter(({ courier, courierStatus, distance: courierDistance, load, sameRestaurantContinuation }) =>
      Boolean(courier.available) &&
      [COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(courierStatus) &&
      courierLocationIsAssignmentUsable(courier) &&
      (load < 1 || (
        load < AUTO_SAME_RESTAURANT_MAX_ACTIVE_PACKAGES &&
        sameRestaurantContinuation
      )) &&
      !excludedCourierIds.has(courier.id) &&
      !cooldownCourierIds.has(courier.id) &&
      Number.isFinite(courierDistance) &&
      courierDistance <= MAX_ASSIGNMENT_DISTANCE_KM
    );

  const freshLocationCandidates = availableCandidates.filter(({ freshLocation }) => freshLocation);
  // Canli GPS verisi olan bir kurye varsa onu her zaman tercih et. Tarayici
  // arka planda askida kaldiginda ise acik vardiyadaki kuryeyi son guvenilir
  // konumuyla havuzdan dusurme; push bildirimi paketi kendisine ulastirir.
  const locationCandidates = freshLocationCandidates.length > 0
    ? freshLocationCandidates
    : availableCandidates;
  const selectedRadius = ASSIGNMENT_SEARCH_RADII_KM.find((radiusKm) =>
    locationCandidates.some(({ distance: courierDistance }) => courierDistance <= radiusKm)
  );
  const selectedPool = selectedRadius === undefined
    ? []
    : locationCandidates
      .filter(({ distance: courierDistance }) => courierDistance <= selectedRadius)
      .map((candidate) => ({
        ...candidate,
        selectionMode: candidate.freshLocation ? "distance_radius_fresh" : "distance_radius_last_known",
        searchRadiusKm: selectedRadius,
      }));

  const ranked = selectedPool
    .sort((left, right) => {
      const leftDistance = Number.isFinite(left.distance) ? left.distance : Number.POSITIVE_INFINITY;
      const rightDistance = Number.isFinite(right.distance) ? right.distance : Number.POSITIVE_INFINITY;
      const leftDistanceBand = Math.floor(leftDistance / ASSIGNMENT_FAIRNESS_DISTANCE_TOLERANCE_KM);
      const rightDistanceBand = Math.floor(rightDistance / ASSIGNMENT_FAIRNESS_DISTANCE_TOLERANCE_KM);
      return left.load - right.load ||
        leftDistanceBand - rightDistanceBand ||
        left.fairness.todayAssignments - right.fairness.todayAssignments ||
        left.fairness.lastAssignedAt - right.fairness.lastAssignedAt ||
        leftDistance - rightDistance ||
        assignmentTieBreaker(pkg.id, left.courier.id) - assignmentTieBreaker(pkg.id, right.courier.id);
    });

  if (ASSIGNMENT_DEBUG_LOGS) {
    logger.debug("Assignment courier distance check", {
      packageId: pkg.id,
      packageStatus: pkg.status,
      zone: pkg.zone,
      packageLat: pkg.latitude,
      packageLng: pkg.longitude,
      skippedCourierIds: [...excludedCourierIds],
      cooldownCourierIds: [...cooldownCourierIds],
      courierCount: state.couriers.length,
      eligibleCourierIds: ranked.map((item) => item.courier.id),
      selectionMode: ranked[0]?.selectionMode || "none",
      coordinateSource: assignmentCoordinates.source,
    });
  }

  return ranked;
}

function candidateDistance(candidate) {
  return Number.isFinite(candidate?.distance) ? Number(candidate.distance.toFixed(2)) : null;
}

function candidateAssignmentReason(pkg, candidate) {
  const searchRadiusKm = Number(candidate?.searchRadiusKm || MAX_ASSIGNMENT_DISTANCE_KM);
  const locationLabel = candidate?.selectionMode === "distance_radius_fresh" ? "guncel GPS" : "kayitli konum";
  if (candidate?.sameRestaurantContinuation) {
    return `Ayni restorandan ikinci paket, ${searchRadiusKm} km icindeki mevcut kuryeye atandi.`;
  }
  return `${searchRadiusKm} km arama capinda ${locationLabel} verisine gore en yakin online ve bos kurye secildi.`;
}

function assignPackage(state, pkg, occupiedCourierLoads = new Map(), options = {}) {
  const packageStatus = normalizeStatus(pkg.status);
  if ([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(packageStatus)) {
    return {
      ...pkg,
      status: packageStatus,
      assignmentStatus: assignmentStatusForOrder(packageStatus),
    };
  }

  if (packageRejectionCooldownRemainingMs(pkg.id) > 0) {
    return pkg;
  }

  const ranked = rankEligibleCouriers(state, pkg, occupiedCourierLoads, options);
  if (ranked.length === 0) {
    const failure = evaluateAssignmentFailure(state, pkg);
    return buildAssignmentFailure(pkg, failure.reason, failure.note);
  }

  const assignmentAttemptAt = nowIso();
  const best = ranked[0];
  return {
    ...pkg,
    assignedCourierId: best.courier.id,
    assignedCourierName: best.courier.name,
    assignedAt: assignmentAttemptAt,
    distanceKm: candidateDistance(best),
    status: ASSIGNED_STATUS,
    assignmentStatus: "assigned",
    lastAssignmentAttemptAt: assignmentAttemptAt,
    lastAssignmentError: "",
    assignmentReason: candidateAssignmentReason(pkg, best),
  };
}

function persistPackageAssignment(pkg) {
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = ?,
        distance_km = ?, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    pkg.status,
    pkg.assignmentStatus || assignmentStatusForOrder(pkg.status),
    pkg.assignedCourierId,
    pkg.assignedCourierName,
    pkg.assignedAt || null,
    pkg.distanceKm,
    pkg.assignmentReason,
    pkg.lastAssignmentAttemptAt || null,
    pkg.lastAssignmentError || null,
    nowIso(),
    pkg.id
  );
  if (pkg.assignedCourierId) {
    updatePlatformOrderStatusByPackage(pkg, "assigned");
    const assignedPackage = getPackageById(pkg.id);
    if (isPlatformBackedPackage(pkg)) {
      notifyPlatformOrderAssigned(
        pkg.sourcePlatform || pkg.source_platform,
        pkg.externalOrderId || pkg.external_order_id || pkg.externalOrderNo || pkg.external_order_no,
        pkg.assignedCourierId,
        assignedPackage
      );
    }
  }
  syncAssignmentRetryForPackage(getPackageById(pkg.id));
}

function updatePackageAssignmentFailure(packageId, reason, note) {
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL,
        distance_km = NULL, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    PREPARING_STATUS,
    "waiting_courier",
    note,
    nowIso(),
    reason,
    nowIso(),
    packageId
  );
  clearAssignmentRetry(packageId);
}

function tryAssignPackageAtomically(pkg, candidate) {
  return withImmediateTransaction(() => {
    logger.debug("Assignment started", {
      packageId: pkg.id,
      courierId: candidate.courier.id,
    });
    const freshPackage = db.prepare("SELECT * FROM packages WHERE id = ?").get(pkg.id);
    if (!freshPackage) {
      return { ok: false, reason: "veri eksik", note: "Siparis kaydi bulunamadi." };
    }

    const freshStatus = normalizeStatus(freshPackage.status);
    const freshOfferExpired = isCourierOfferExpired(mapPackageRow(freshPackage, new Map()));
    if (!isAssignableOrderStatus(freshStatus) || (freshStatus === ASSIGNED_STATUS && !freshOfferExpired)) {
      return { ok: false, reason: "sistemsel hata", note: "Siparis bu durumda otomatik atamaya uygun degil." };
    }

    const targetCourier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(candidate.courier.id);
    if (!targetCourier) {
      updatePackageAssignmentFailure(pkg.id, "uygun kurye yok", "Secilen kurye kaydi bulunamadi.");
      return { ok: false, reason: "uygun kurye yok", note: "Secilen kurye kaydi bulunamadi." };
    }

    const courierStatus = normalizeCourierStatus(targetCourier.status, Boolean(targetCourier.available));
    if (!Boolean(targetCourier.available) || ![COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(courierStatus)) {
      updatePackageAssignmentFailure(pkg.id, "uygun kurye yok", "Kurye online olmadigi icin atama yapilamadi.");
      return { ok: false, reason: "uygun kurye yok", note: "Kurye online olmadigi icin atama yapilamadi." };
    }

    const activePackages = db.prepare(`
        SELECT restaurant_id, status
        FROM packages
        WHERE assigned_courier_id = ?
          AND id != ?
          AND status IN (?, ?, ?)
          AND NOT (
            status = ?
            AND assigned_at IS NOT NULL
            AND (strftime('%s','now') - strftime('%s', assigned_at)) * 1000 >= ?
          )
      `).all(
        targetCourier.id,
        pkg.id,
        ASSIGNED_STATUS,
        ACCEPTED_BY_COURIER_STATUS,
        ON_ROUTE_STATUS,
        ASSIGNED_STATUS,
        COURIER_OFFER_TIMEOUT_MS
      );
    const activeLoad = activePackages.length;
    const sameRestaurantContinuation = activeLoad === AUTO_SAME_RESTAURANT_MAX_ACTIVE_PACKAGES - 1 &&
      activePackages[0]?.restaurant_id === freshPackage.restaurant_id &&
      [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(normalizeStatus(activePackages[0]?.status));

    if (activeLoad >= 1 && !sameRestaurantContinuation) {
      updatePackageAssignmentFailure(pkg.id, "tum kuryeler busy", "Secilen kurye zaten aktif bir pakete sahip.");
      return { ok: false, reason: "tum kuryeler busy", note: "Secilen kurye zaten aktif bir pakete sahip." };
    }

    const assignmentAttemptAt = nowIso();
    const update = db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = ?,
          distance_km = ?, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = '', updated_at = ?
      WHERE id = ?
        AND (
          status IN (?, ?, ?, ?, ?)
          OR (
            status = ?
            AND assigned_at IS NOT NULL
            AND (strftime('%s','now') - strftime('%s', assigned_at)) * 1000 >= ?
          )
        )
    `).run(
      ASSIGNED_STATUS,
      "assigned",
      targetCourier.id,
      targetCourier.name,
      assignmentAttemptAt,
      candidateDistance(candidate),
      candidateAssignmentReason({ zone: freshPackage.zone }, { ...candidate, sameRestaurantContinuation }),
      assignmentAttemptAt,
      assignmentAttemptAt,
      pkg.id,
      PREPARING_STATUS,
      PENDING_STATUS,
      AWAITING_ASSIGNMENT_STATUS,
      ASSIGNED_STATUS,
      FAILED_STATUS,
      ASSIGNED_STATUS,
      COURIER_OFFER_TIMEOUT_MS
    );

    if (update.changes !== 1) {
      logger.warn("Assignment skipped due to concurrent change", {
        packageId: pkg.id,
        courierId: targetCourier.id,
      });
      return { ok: false, reason: "sistemsel hata", note: "Siparis bu arada baska bir islem tarafindan degisti." };
    }

    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(COURIER_BUSY_STATUS, targetCourier.id);
    appendTriedCourier(pkg.id, targetCourier.id);
    const assignedPackage = getPackageById(pkg.id);
    syncAssignmentRetryForPackage(assignedPackage);
    logger.info("Assignment success", {
      packageId: pkg.id,
      courierId: targetCourier.id,
      courierStatus,
      distanceKm: candidateDistance(candidate),
    });
    if (isPlatformBackedPackage(freshPackage)) {
      notifyPlatformOrderAssigned(freshPackage.source_platform, freshPackage.external_order_id || freshPackage.external_order_no, targetCourier.id, assignedPackage);
    }
    return { ok: true, courierId: targetCourier.id };
  });
}

async function handleAssignmentRetry(packageId) {
  clearAssignmentRetry(packageId);
  const target = getPackageById(packageId);
  if (!target || normalizeStatus(target.status) !== ASSIGNED_STATUS || !target.assignedCourierId) {
    return;
  }

  logger.info("Assignment retry triggered", {
    packageId,
    assignedCourierId: target.assignedCourierId,
    triedCourierIds: target.assignmentTriedCourierIds || [],
  });

  const state = currentState();
  syncCourierOperationalStatuses(state);
  const occupiedCourierLoads = new Map();
  state.packages
    .filter((pkg) => isCapacityBlockingPackage(pkg))
    .forEach((pkg) => reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, 1));

  const excludedCourierIds = normalizeIdList([
    ...(target.assignmentTriedCourierIds || []),
    target.assignedCourierId,
  ]);
  excludedCourierIds.forEach((courierId) => {
    logger.debug("Courier skipped because already tried", { packageId, courierId });
  });

  const ranked = rankEligibleCouriers(state, target, occupiedCourierLoads, { excludedCourierIds });
  if (ranked.length === 0) {
    logger.warn("Retry assignment found no suitable courier", { packageId });
    updatePackageAssignmentFailure(packageId, "mesafe disi", "Retry assignment: no suitable courier found");
    setPackageTriedCouriers(packageId, []);
    broadcastLiveEvent({
      type: "assignment-waiting",
      restaurantId: target.restaurantId,
      message: `${target.trackingNo || target.id} paketi yeniden atama sonrasi uygun kurye bulamadi.`,
    });
    return;
  }

  for (const candidate of ranked) {
    const result = tryAssignPackageAtomically(target, candidate);
    if (result.ok) {
      logger.info("Retry assignment selected a new courier", {
        packageId,
        courierId: candidate.courier.id,
      });
      const assignedPackage = getPackageById(packageId);
      syncAssignmentRetryForPackage(assignedPackage);
      broadcastLiveEvent({
        type: "package-reassign",
        packageId,
        restaurantId: target.restaurantId,
        courierId: candidate.courier.id,
        message: `${target.trackingNo || target.id} paketi yeni kuryeye yeniden atandi.`,
      });
      return;
    }
  }

  logger.warn("Retry assignment found no suitable courier", { packageId });
  updatePackageAssignmentFailure(packageId, "mesafe disi", "Retry assignment: no suitable courier found");
  setPackageTriedCouriers(packageId, []);
}

function attemptPackageAssignment(state, pkg, occupiedCourierLoads, options = {}) {
  const packageStatus = normalizeStatus(pkg.status);
  const offerExpired = isCourierOfferExpired(pkg);
  if (!isAssignableOrderStatus(packageStatus) || (packageStatus === ASSIGNED_STATUS && !offerExpired)) {
    return false;
  }

  const rejectionCooldownRemainingMs = packageRejectionCooldownRemainingMs(pkg.id);
  if (rejectionCooldownRemainingMs > 0) {
    logger.debug("Assignment waiting after courier rejection", {
      packageId: pkg.id,
      remainingMs: rejectionCooldownRemainingMs,
    });
    return false;
  }

  const excludedCourierIds = normalizeIdList([
    ...(pkg.assignmentTriedCourierIds || []),
    ...(offerExpired && pkg.assignedCourierId ? [pkg.assignedCourierId] : []),
  ]);
  let ranked = rankEligibleCouriers(
    state,
    pkg,
    occupiedCourierLoads,
    {
      ...(excludedCourierIds.length ? { excludedCourierIds } : {}),
      cooldownCourierIds: options.cooldownCourierIds,
    }
  );

  if (ranked.length === 0 && excludedCourierIds.length > 0 && options.allowRoundRestart === false) {
    options.deferredRoundPackageIds?.add(pkg.id);
    return false;
  }

  if (ranked.length === 0 && excludedCourierIds.length > 0) {
    const nextRound = rankEligibleCouriers(state, pkg, occupiedCourierLoads, {
      cooldownCourierIds: options.cooldownCourierIds,
    });
    if (nextRound.length > 0) {
      logger.info("Assignment courier round restarted", {
        packageId: pkg.id,
        completedCourierIds: excludedCourierIds,
        nextCourierId: nextRound[0].courier.id,
      });
      setPackageTriedCouriers(pkg.id, []);
      pkg.assignmentTriedCourierIds = [];
      const packageIndex = state.packages.findIndex((item) => item.id === pkg.id);
      if (packageIndex >= 0) {
        state.packages[packageIndex].assignmentTriedCourierIds = [];
      }
      ranked = nextRound;
    }
  }

  if (ranked.length === 0) {
    const failure = evaluateAssignmentFailure(state, pkg);
    persistPackageAssignment(buildAssignmentFailure(pkg, failure.reason, failure.note));
    return false;
  }

  for (const candidate of ranked) {
    const result = tryAssignPackageAtomically(pkg, candidate);
    if (result.ok) {
      reserveCourier(occupiedCourierLoads, candidate.courier.id, 1);
      const packageIndex = state.packages.findIndex((item) => item.id === pkg.id);
      if (packageIndex >= 0) {
        state.packages[packageIndex] = {
          ...state.packages[packageIndex],
          status: ASSIGNED_STATUS,
          assignmentStatus: "assigned",
          assignedCourierId: candidate.courier.id,
          assignedCourierName: candidate.courier.name,
          assignedAt: nowIso(),
          distanceKm: candidateDistance(candidate),
          lastAssignmentAttemptAt: nowIso(),
          lastAssignmentError: "",
          assignmentTriedCourierIds: normalizeIdList([...(state.packages[packageIndex].assignmentTriedCourierIds || []), candidate.courier.id]),
        };
      }
      const courierIndex = state.couriers.findIndex((item) => item.id === candidate.courier.id);
      if (courierIndex >= 0) {
        state.couriers[courierIndex] = {
          ...state.couriers[courierIndex],
          status: COURIER_BUSY_STATUS,
        };
      }
      broadcastLiveEvent({
        type: "package-assigned",
        packageId: pkg.id,
        restaurantId: pkg.restaurantId,
        courierId: candidate.courier.id,
        message: `${pkg.trackingNo || pkg.id} paketi ${candidate.courier.name} kuryesine atandi.`,
      });
      return true;
    }
  }

  const failure = evaluateAssignmentFailure(currentState(), pkg);
  persistPackageAssignment(buildAssignmentFailure(pkg, failure.reason, failure.note));
  broadcastLiveEvent({
    type: "assignment-waiting",
    restaurantId: pkg.restaurantId,
    message: `${pkg.trackingNo || pkg.id} paketi hala uygun kurye bekliyor.`,
  });
  return false;
}

function getShiftPlans(planDate = dayKey()) {
  expirePendingShiftPlans();
  return db.prepare(`
    SELECT plans.*, couriers.name AS courier_name, couriers.zone AS courier_zone
    FROM courier_shift_plans plans
    JOIN couriers ON couriers.id = plans.courier_id
    WHERE plans.plan_date = ?
    ORDER BY plans.start_time ASC
  `).all(planDate).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.zone || row.courier_zone,
    planDate: row.plan_date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    offerExpiresAt: row.offer_expires_at || null,
    acceptedAt: row.accepted_at || null,
    notifiedAt: row.notified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getCourierShiftPlans(courierId, limit = 12) {
  expirePendingShiftPlans();
  return db.prepare(`
    SELECT plans.*, couriers.name AS courier_name, couriers.zone AS courier_zone
    FROM courier_shift_plans plans
    JOIN couriers ON couriers.id = plans.courier_id
    WHERE plans.courier_id = ?
    ORDER BY datetime(plans.plan_date || 'T' || plans.start_time) DESC, datetime(plans.updated_at) DESC
    LIMIT ?
  `).all(courierId, limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.zone || row.courier_zone,
    planDate: row.plan_date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    offerExpiresAt: row.offer_expires_at || null,
    acceptedAt: row.accepted_at || null,
    notifiedAt: row.notified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function summarizeShiftPlans(planDate = dayKey()) {
  const plans = getShiftPlans(planDate);
  return getZones().map((zone) => {
    const zonePlans = plans.filter((plan) => plan.zone === zone);
    const active = zonePlans.length;
    return {
      zone,
      plannedCouriers: active,
      missingCouriers: Math.max(0, 2 - active),
    };
  });
}

function upsertCashReconciliation(courierId, reportDate, summary) {
  const now = nowIso();
  const expectedCash = Number(summary.cashCollectedAmount || 0);
  const variance = 0;
  const existing = db.prepare("SELECT * FROM cash_reconciliations WHERE courier_id = ? AND report_date = ?").get(courierId, reportDate);
  if (existing) {
    db.prepare(`
      UPDATE cash_reconciliations
      SET expected_cash = ?, reported_cash = ?, variance = ?, status = 'pending', admin_note = NULL, package_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(expectedCash, expectedCash, variance, json(summary.packageIds || []), now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO cash_reconciliations (id, courier_id, report_date, expected_cash, reported_cash, variance, status, package_ids_json, admin_note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
    `).run(uid("cash"), courierId, reportDate, expectedCash, expectedCash, variance, json(summary.packageIds || []), now, now);
  }
}

function getCashReconciliations(limit = 30) {
  return db.prepare(`
    SELECT reconciliations.*, couriers.name AS courier_name, couriers.zone AS courier_zone
    FROM cash_reconciliations reconciliations
    JOIN couriers ON couriers.id = reconciliations.courier_id
    ORDER BY datetime(reconciliations.updated_at) DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.courier_zone,
    reportDate: row.report_date,
    expectedCash: Number(row.expected_cash || 0),
    reportedCash: Number(row.reported_cash || 0),
    variance: Number(row.variance || 0),
    status: row.status,
    packageIds: parseJson(row.package_ids_json, []),
    adminNote: row.admin_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function upsertShiftPlan(courierId, planDate, startTime, endTime, zone) {
  const courier = getCourierById(courierId);
  if (!courier) {
    throw httpError(404, "Kurye bulunamadi.");
  }
  const stamp = nowIso();
  const offerExpiresAt = plusHoursIso(stamp, 1);
  const existing = db.prepare("SELECT * FROM courier_shift_plans WHERE courier_id = ? AND plan_date = ?").get(courierId, planDate);
  if (existing) {
    db.prepare(`
      UPDATE courier_shift_plans
      SET zone = ?, start_time = ?, end_time = ?, status = 'awaiting_courier_acceptance', offer_expires_at = ?, accepted_at = NULL, notified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(zone || courier.zone, startTime, endTime, offerExpiresAt, stamp, stamp, existing.id);
    return existing.id;
  }

  const id = uid("shiftplan");
  db.prepare(`
    INSERT INTO courier_shift_plans (id, courier_id, zone, plan_date, start_time, end_time, status, offer_expires_at, accepted_at, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'awaiting_courier_acceptance', ?, NULL, ?, ?, ?)
  `).run(id, courierId, zone || courier.zone, planDate, startTime, endTime, offerExpiresAt, stamp, stamp, stamp);
  return id;
}

function expirePendingShiftPlans() {
  db.prepare(`
    UPDATE courier_shift_plans
    SET status = 'expired', updated_at = ?
    WHERE status = 'awaiting_courier_acceptance'
      AND offer_expires_at IS NOT NULL
      AND datetime(offer_expires_at) <= datetime(?)
  `).run(nowIso(), nowIso());
}

function acceptShiftPlan(courierId, planId) {
  expirePendingShiftPlans();
  const plan = db.prepare("SELECT * FROM courier_shift_plans WHERE id = ? AND courier_id = ?").get(planId, courierId);
  if (!plan) {
    throw httpError(404, "Vardiya plani bulunamadi.");
  }
  if (plan.status === "accepted") {
    return plan.id;
  }
  if (plan.status !== "awaiting_courier_acceptance") {
    throw httpError(400, "Bu vardiya plani artik onaylanamaz.");
  }
  if (plan.offer_expires_at && new Date(plan.offer_expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE courier_shift_plans SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), plan.id);
    throw httpError(400, "Vardiya onay suresi doldu.");
  }

  const stamp = nowIso();
  db.prepare(`
    UPDATE courier_shift_plans
    SET status = 'accepted', accepted_at = ?, updated_at = ?
    WHERE id = ?
  `).run(stamp, stamp, plan.id);
  return plan.id;
}

function updateCashReconciliationRecord(recordId, payload = {}) {
  const current = db.prepare("SELECT * FROM cash_reconciliations WHERE id = ?").get(recordId);
  if (!current) {
    throw httpError(404, "Nakit mutabakat kaydi bulunamadi.");
  }

  const expectedCash = Number(current.expected_cash || 0);
  const reportedCash = payload.reportedCash === undefined || payload.reportedCash === ""
    ? Number(current.reported_cash || expectedCash)
    : normalizeMoney(payload.reportedCash);
  const status = trimmed(payload.status) || current.status || "pending";
  const adminNote = trimmed(payload.adminNote) || current.admin_note || "";
  const variance = Number((reportedCash - expectedCash).toFixed(2));

  db.prepare(`
    UPDATE cash_reconciliations
    SET reported_cash = ?, variance = ?, status = ?, admin_note = ?, updated_at = ?
    WHERE id = ?
  `).run(reportedCash, variance, status, adminNote, nowIso(), recordId);

  return db.prepare("SELECT * FROM cash_reconciliations WHERE id = ?").get(recordId);
}

function mapManagementRecord(row) {
  return {
    id: row.id,
    recordType: row.record_type,
    subjectType: row.subject_type || "",
    subjectId: row.subject_id || "",
    title: row.title,
    amount: Number(row.amount || 0),
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    status: row.status || "active",
    note: row.note || "",
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getManagementRecords(filters = {}) {
  const where = [];
  const params = [];
  if (trimmed(filters.recordType)) { where.push("record_type = ?"); params.push(trimmed(filters.recordType)); }
  if (trimmed(filters.subjectType)) { where.push("subject_type = ?"); params.push(trimmed(filters.subjectType)); }
  if (trimmed(filters.subjectId)) { where.push("subject_id = ?"); params.push(trimmed(filters.subjectId)); }
  if (trimmed(filters.status)) { where.push("status = ?"); params.push(trimmed(filters.status)); }
  return db.prepare(`SELECT * FROM management_records${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY datetime(updated_at) DESC LIMIT 500`).all(...params).map(mapManagementRecord);
}

function createManagementRecord(payload = {}) {
  const recordType = trimmed(payload.recordType);
  const title = trimmed(payload.title);
  if (!recordType || !title) throw httpError(400, "Kayit turu ve baslik zorunludur.");
  const id = uid("mgmt");
  const stamp = nowIso();
  db.prepare(`INSERT INTO management_records (id, record_type, subject_type, subject_id, title, amount, start_date, end_date, status, note, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, recordType, trimmed(payload.subjectType), trimmed(payload.subjectId), title, normalizeMoney(payload.amount), trimmed(payload.startDate) || null, trimmed(payload.endDate) || null, trimmed(payload.status) || "active", trimmed(payload.note), json(payload.metadata || {}), stamp, stamp);
  return getManagementRecords().find((item) => item.id === id);
}

function updateManagementRecord(recordId, payload = {}) {
  const current = db.prepare("SELECT * FROM management_records WHERE id = ?").get(recordId);
  if (!current) throw httpError(404, "Yonetim kaydi bulunamadi.");
  db.prepare(`UPDATE management_records SET title = ?, amount = ?, start_date = ?, end_date = ?, status = ?, note = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(
    trimmed(payload.title ?? current.title) || current.title,
    payload.amount === undefined ? Number(current.amount || 0) : normalizeMoney(payload.amount),
    trimmed(payload.startDate ?? current.start_date) || null,
    trimmed(payload.endDate ?? current.end_date) || null,
    trimmed(payload.status ?? current.status) || "active",
    trimmed(payload.note ?? current.note),
    json(payload.metadata ?? parseJson(current.metadata_json, {})),
    nowIso(),
    recordId
  );
  return mapManagementRecord(db.prepare("SELECT * FROM management_records WHERE id = ?").get(recordId));
}

function syncManagementRecordAccounting(record) {
  if (!record || record.recordType !== "courier_adjustment" || !record.subjectId || !record.startDate) return;
  const existing = db.prepare("SELECT payment_status FROM courier_earnings WHERE courier_id = ? AND report_date = ?").get(record.subjectId, record.startDate);
  if (existing?.payment_status === "paid") return;
  syncCourierEarning(record.subjectId, record.startDate);
}

function adminAssignPackageToCourier(packageId, courierId) {
  return withImmediateTransaction(() => {
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    if (!target) {
      throw httpError(404, "Paket bulunamadi.");
    }

    const targetStatus = normalizeStatus(target.status);
    if ([PENDING_APPROVAL_STATUS, REJECTED_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(targetStatus)) {
      throw httpError(400, "Bu durumdaki paket manuel override ile atanamaz.");
    }

    if (targetStatus === ACCEPTED_BY_COURIER_STATUS && target.assigned_courier_id === courierId) {
      throw httpError(400, "Paket zaten secilen kuryede.");
    }

    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
    if (!courier) {
      throw httpError(404, "Kurye bulunamadi.");
    }

    const courierStatus = normalizeCourierStatus(courier.status, Boolean(courier.available));
    if (!Boolean(courier.available) || ![COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(courierStatus)) {
      throw httpError(400, "Secilen kurye online veya aktif durumda degil.");
    }

    const activeLoad = Number(
      db.prepare(`
        SELECT COUNT(*) AS total
        FROM packages
        WHERE assigned_courier_id = ?
          AND id != ?
          AND status IN (?, ?, ?)
      `).get(courier.id, packageId, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0
    );
    if (activeLoad >= ADMIN_MANUAL_MAX_ACTIVE_PACKAGES) {
      throw httpError(400, `Secilen kurye admin manuel atama limitine ulasti (${ADMIN_MANUAL_MAX_ACTIVE_PACKAGES} aktif paket).`);
    }

    const assignedAt = nowIso();
    const autoAccepted = activeLoad >= 1;
    const assignedStatus = autoAccepted ? ACCEPTED_BY_COURIER_STATUS : ASSIGNED_STATUS;
    db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = ?,
          accepted_at = ?, on_route_at = NULL, delivered_at = NULL, failed_at = NULL, distance_km = NULL,
          failure_reason = NULL, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = '', updated_at = ?
      WHERE id = ?
    `).run(
      assignedStatus,
      "assigned",
      courier.id,
      courier.name,
      assignedAt,
      autoAccepted ? assignedAt : null,
      autoAccepted
        ? `Admin override ile ${activeLoad + 1}. paket olarak atandi ve otomatik kabul edildi.`
        : "Admin override ile belirli kuryeye atandi; kurye onayi bekleniyor.",
      assignedAt,
      assignedAt,
      packageId
    );
    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(COURIER_BUSY_STATUS, courier.id);
    appendTriedCourier(packageId, courier.id);
    const assignedPackage = getPackageById(packageId);
    syncAssignmentRetryForPackage(assignedPackage);
    if (autoAccepted) {
      enqueuePosentegraStatusChange(assignedPackage, assignedStatus);
    }
    if (isPlatformBackedPackage(target)) {
      notifyPlatformOrderAssigned(target.source_platform, target.external_order_id || target.external_order_no, courier.id, assignedPackage);
    }
    return {
      packageId,
      restaurantId: target.restaurant_id || null,
      previousCourierId: target.assigned_courier_id || null,
      courierId: courier.id,
      courierName: courier.name,
      activeLoad: activeLoad + 1,
      manualCapacity: ADMIN_MANUAL_MAX_ACTIVE_PACKAGES,
      autoAccepted,
    };
  });
}

function adminUnassignPackage(packageId) {
  return withImmediateTransaction(() => {
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    if (!target) {
      throw httpError(404, "Paket bulunamadi.");
    }

    const targetStatus = normalizeStatus(target.status);
    if ([ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(targetStatus)) {
      throw httpError(400, "Bu durumdaki paketin atamasi kaldirilamaz.");
    }

    const previousCourierId = target.assigned_courier_id || null;
    const stamp = nowIso();

    db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL,
          accepted_at = NULL, on_route_at = NULL, delivered_at = NULL, failed_at = NULL, distance_km = NULL,
          failure_reason = NULL, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      AWAITING_ASSIGNMENT_STATUS,
      "pending",
      "Admin mevcut atamayi kaldirdi ve siparisi havuza geri aldi.",
      stamp,
      "admin override ile atama kaldirildi",
      stamp,
      packageId
    );
    clearAssignmentRetry(packageId);
    setPackageTriedCouriers(packageId, previousCourierId ? [previousCourierId] : []);
    return {
      packageId,
      restaurantId: target.restaurant_id || null,
      previousCourierId,
      previousStatus: targetStatus,
    };
  });
}

function syncCourierOperationalStatuses(state = currentState()) {
  state.couriers.forEach((courier) => {
    const load = activeAssignmentsForCourier(state.packages, courier.id);
    const nextStatus = !courier.available
      ? COURIER_OFFLINE_STATUS
      : load > 0
        ? COURIER_BUSY_STATUS
        : COURIER_ONLINE_STATUS;
    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(nextStatus, courier.id);
    courier.status = nextStatus;
  });
}

function rebalancePackages() {
  if (assignmentSweepRunning) {
    assignmentSweepQueued = true;
    return;
  }

  assignmentSweepRunning = true;
  try {
  const state = currentState();
  syncCourierOperationalStatuses(state);
  const occupiedCourierLoads = new Map();
  state.packages
    .filter((pkg) => isCapacityBlockingPackage(pkg))
    .forEach((pkg) => reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, 1));

  const candidatePackages = state.packages
    .filter((pkg) => {
      const status = normalizeStatus(pkg.status);
      const assignableStatus = [PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, FAILED_STATUS].includes(status)
        || isCourierOfferExpired(pkg);
      return assignableStatus && isFreshAutomaticAssignmentCandidate(pkg);
    })
    .sort((left, right) => waitingPackagePriority(left) - waitingPackagePriority(right));

  const cooldownCourierIds = activeCourierRejectionCooldownIds();
  const deferredRoundPackageIds = new Set();
  candidatePackages.forEach((pkg) => {
    attemptPackageAssignment(state, pkg, occupiedCourierLoads, {
      allowRoundRestart: false,
      deferredRoundPackageIds,
      cooldownCourierIds,
    });
  });

  deferredRoundPackageIds.forEach((packageId) => {
    const deferredPackage = state.packages.find((pkg) => pkg.id === packageId);
    if (!deferredPackage || deferredPackage.assignedCourierId) {
      return;
    }
    attemptPackageAssignment(state, deferredPackage, occupiedCourierLoads, { cooldownCourierIds });
  });

  } finally {
    assignmentSweepRunning = false;
    if (assignmentSweepQueued) {
      assignmentSweepQueued = false;
      setImmediate(() => rebalancePackages());
    }
  }
}

function scheduleRebalancePackages() {
  setImmediate(() => {
    try {
      rebalancePackages();
    } catch (error) {
      logger.warn("Scheduled rebalance failed", { error });
    }
  });
}

function scheduleRebalanceAfterRejectionCooldown() {
  const delayMs = Math.max(0, PACKAGE_REJECTION_COOLDOWN_MS) + 25;
  const timer = setTimeout(() => {
    try {
      rebalancePackages();
    } catch (error) {
      logger.warn("Post-rejection assignment retry failed", { error });
    }
  }, delayMs);
  timer.unref?.();
}

function retryAwaitingAssignmentPackages() {
  rebalancePackages();
}

function stats(state) {
  return {
    totalRestaurants: state.restaurants.length,
    totalCouriers: state.couriers.length,
    totalPlatformAccounts: state.platformAccounts.length,
    activeCouriers: state.couriers.filter((item) => item.status === COURIER_ONLINE_STATUS || item.status === COURIER_BUSY_STATUS).length,
    totalPackages: state.packages.length,
    waitingPackages: state.packages.filter((item) => [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
    assignedPackages: state.packages.filter((item) => item.assignedCourierId).length,
    inTransitPackages: state.packages.filter((item) => [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(item.status)).length,
    deliveredPackages: state.packages.filter((item) => item.status === DELIVERED_STATUS).length,
  };
}

function statsFromDb(filter = {}) {
  const packageWhere = filter.restaurantId ? "restaurant_id = ?" : "";
  const packageParams = filter.restaurantId ? [filter.restaurantId] : [];
  const activeStatuses = [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS];
  const transitStatuses = [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS];
  const wherePrefix = packageWhere ? `${packageWhere} AND ` : "";
  return {
    totalRestaurants: filter.restaurantId ? 1 : countTable("restaurants"),
    totalCouriers: countTable("couriers"),
    totalPlatformAccounts: filter.restaurantId ? countTable("platform_accounts", "restaurant_id = ?", [filter.restaurantId]) : countTable("platform_accounts"),
    activeCouriers: countTable("couriers", "status IN (?, ?)", [COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS]),
    totalPackages: countTable("packages", packageWhere, packageParams),
    waitingPackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${wherePrefix}status IN (${activeStatuses.map(() => "?").join(",")})`).get(...packageParams, ...activeStatuses).count,
    assignedPackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${wherePrefix}assigned_courier_id IS NOT NULL`).get(...packageParams).count,
    inTransitPackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${wherePrefix}status IN (${transitStatuses.map(() => "?").join(",")})`).get(...packageParams, ...transitStatuses).count,
    deliveredPackages: countTable("packages", packageWhere ? `${packageWhere} AND status = ?` : "status = ?", [...packageParams, DELIVERED_STATUS]),
  };
}

function decorateState(filter = {}) {
  const pagination = filter.pagination || paginationFromRequest(filter.req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  const paginatedFilter = { ...filter, pagination };
  const state = currentState(paginatedFilter);
  const restaurantMap = new Map(state.restaurants.map((item) => [item.id, item.name]));
  const restaurantLocationMap = new Map(state.restaurants.map((item) => [item.id, item]));
  const activeLoadMap = buildActiveLoadMap(state.packages);

  const couriers = state.couriers.map((courier) => ({
    ...sanitizeCourier(courier),
    activeLoad: activeLoadMap.get(courier.id) || 0,
  }));

  const packages = state.packages.map((pkg) => ({
    ...pkg,
    restaurantName: restaurantMap.get(pkg.restaurantId) || "Bilinmeyen Restoran",
    restaurantLat: restaurantLocationMap.get(pkg.restaurantId)?.latitude ?? pkg.restaurantLat ?? pkg.latitude,
    restaurantLng: restaurantLocationMap.get(pkg.restaurantId)?.longitude ?? pkg.restaurantLng ?? pkg.longitude,
  }));

  const zones = state.zones.map((zone) => ({
    name: zone,
    courierCount: couriers.filter((item) => item.zone === zone).length,
    activeCourierCount: couriers.filter((item) => item.zone === zone && (item.status === COURIER_ONLINE_STATUS || item.status === COURIER_BUSY_STATUS)).length,
    packageCount: packages.filter((item) => item.zone === zone).length,
    waitingCount: packages.filter((item) => item.zone === zone && [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
  }));
  const sanitizedPlatformAccounts = state.platformAccounts.map((account) => sanitizePlatformAccount(account, Boolean(filter.includePlatformSecrets || filter.includeRestaurantSecrets)));
  const restaurantScoped = Boolean(filter.restaurantId);
  const courierScoped = Boolean(filter.courierId);
  const adminScoped = !restaurantScoped && !courierScoped;
  const restaurantAccounting = buildRestaurantAccounting({
    startDate: trimmed(filter.accountingStartDate) || dayKey(),
    endDate: trimmed(filter.accountingEndDate) || dayKey(),
    restaurantId: restaurantScoped ? filter.restaurantId : "",
  });
  const restaurantSettlements = getRestaurantSettlements(50, restaurantScoped ? filter.restaurantId : "");

  return {
    systemSettings: getSystemSettings(),
    zones,
    zoneAlerts: buildZoneAlerts(zones, packages),
    restaurants: state.restaurants.map((restaurant) => sanitizeRestaurant(restaurant, Boolean(filter.includeRestaurantSecrets))),
    platformAccounts: sanitizedPlatformAccounts,
    platformOrders: state.platformOrders,
    unmatchedOrders: adminScoped ? getUnmatchedOrders(100) : [],
    couriers,
    packages,
    customers: filter.restaurantId ? getRestaurantCustomers(filter.restaurantId) : [],
    restaurantAccounting: restaurantScoped || adminScoped ? restaurantAccounting : [],
    restaurantSettlements: restaurantScoped || adminScoped ? restaurantSettlements : [],
    courierDailyReports: adminScoped ? getCourierDailyReports(50) : [],
    courierEarnings: adminScoped ? getCourierEarnings({ date: dayKey() }) : [],
    shiftPlans: adminScoped ? getShiftPlans(dayKey()) : [],
    shiftPlanSummary: adminScoped ? summarizeShiftPlans(dayKey()) : [],
    cashReconciliations: adminScoped ? getCashReconciliations(30) : [],
    managementRecords: restaurantScoped
      ? getManagementRecords({ subjectType: "restaurant", subjectId: filter.restaurantId })
      : courierScoped
        ? getManagementRecords({ subjectType: "courier", subjectId: filter.courierId })
        : getManagementRecords(),
    announcements: filter.courierId ? getAnnouncements("courier") : getAnnouncements(),
    notifications: filter.courierId
      ? getNotifications("courier", filter.courierId, 20)
      : filter.restaurantId
        ? getNotifications("restaurant", filter.restaurantId, 20)
        : getNotifications("admin", null, 20),
    webhookLogs: state.webhookLogs,
    platformEvents: state.platformEvents,
    pagination: {
      packages: packagePagination(filter, pagination),
      platformOrders: platformOrdersPagination(filter, pagination),
      webhookLogs: pageMeta(filter.restaurantId ? countTable("webhook_logs", "restaurant_id = ?", [filter.restaurantId]) : countTable("webhook_logs"), { limit: 20, offset: 0 }),
      auditLogs: pageMeta(filter.restaurantId ? countTable("audit_logs", "restaurant_id = ?", [filter.restaurantId]) : countTable("audit_logs"), { limit: 20, offset: 0 }),
    },
    stats: statsFromDb(filter),
    systemStatus: {
      queues: queueHealthPayload(),
      cache: cacheHealthPayload(),
      totals: {
        failedWebhooks: tableCountSafe("webhook_logs", "(response_status >= 400 OR dead_lettered_at IS NOT NULL)"),
        deadLetteredWebhooks: tableCountSafe("webhook_logs", "dead_lettered_at IS NOT NULL"),
      },
      lastRequestId: recentRequestLogs.at(-1)?.requestId || null,
      platformHealth: platformHealthSummaryPayload(),
    },
    restaurantPerformance: filter.restaurantId ? buildRestaurantPerformance(packages) : null,
    integrationWizard: filter.restaurantId ? buildRestaurantIntegrationWizard(filter.req || { headers: {}, url: "/" }, state.restaurants[0] || null, sanitizedPlatformAccounts) : null,
  };
}

function logWebhookAttempt(entry) {
  const safeRequestBody = redactSecretsFromText(entry.requestBody);
  const result = db.prepare(`
    INSERT INTO webhook_logs (
      restaurant_id, source_platform, external_order_no, signature_valid, response_status, request_body,
      retry_count, next_retry_at, dead_lettered_at, last_error, request_id, provider, platform,
      external_restaurant_id, external_order_id, is_matched, status, http_status, error_message,
      raw_payload, headers, ip_address, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.restaurantId || null,
    entry.sourcePlatform || null,
    entry.externalOrderNo || null,
    entry.signatureValid ? 1 : 0,
    entry.responseStatus,
    safeRequestBody,
    Number(entry.retryCount || 0),
    entry.nextRetryAt || null,
    entry.deadLetteredAt || null,
    entry.lastError || null,
    entry.requestId || null,
    entry.provider || null,
    entry.platform || entry.sourcePlatform || null,
    entry.externalRestaurantId || null,
    entry.externalOrderId || entry.externalOrderNo || null,
    entry.isMatched === undefined ? null : (entry.isMatched ? 1 : 0),
    entry.status || null,
    entry.httpStatus || entry.responseStatus || null,
    entry.errorMessage || entry.lastError || null,
    entry.rawPayload ? json(entry.rawPayload) : safeRequestBody,
    entry.headers ? json(entry.headers) : null,
    entry.ipAddress || null,
    new Date().toISOString()
  );

  const line = `[${new Date().toISOString()}] status=${entry.responseStatus} signature=${entry.signatureValid ? "valid" : "invalid"} restaurant=${entry.restaurantId || "-"} platform=${entry.sourcePlatform || "-"} order=${entry.externalOrderNo || "-"}${"\n"}`;
  fs.appendFileSync(WEBHOOK_LOG_FILE, line);
  return Number(result.lastInsertRowid || 0);
}

function logPosentegraApiAttempt({ requestId, restaurantId = null, packageId = null, event, responseStatus, requestBody = null, responseBody = null, error = null, externalRestaurantId = null, externalOrderId = null, isMatched = null }) {
  return logWebhookAttempt({
    requestId,
    restaurantId,
    sourcePlatform: "Posentegra",
    provider: "posentegra",
    platform: "posentegra",
    externalRestaurantId,
    externalOrderId,
    externalOrderNo: externalOrderId,
    signatureValid: !error,
    responseStatus: responseStatus || (error ? 502 : 200),
    status: event,
    isMatched,
    requestBody: json({
      event,
      packageId,
      request: requestBody || null,
      response: responseBody || null,
      error: error ? { message: error.message, code: error.code || null } : null,
    }),
    rawPayload: {
      event,
      packageId,
      request: requestBody || null,
      response: responseBody || null,
      error: error ? { message: error.message, code: error.code || null } : null,
    },
    lastError: error?.message || null,
    errorMessage: error?.message || null,
  });
}

function extractPosentegraRestaurantId(result) {
  const body = result?.responseBody || {};
  return trimmed(body.id || body.restaurantId || body.restaurant_id || body.data?.id || body.data?.restaurantId || body.data?.restaurant_id);
}

function updateRestaurantPosentegraIdOrThrow(restaurantId, posentegraId, requestId) {
  const incoming = trimmed(posentegraId);
  if (!incoming) {
    throw validationError("Posentegra restoran ID bos dondu.");
  }
  db.prepare("UPDATE restaurants SET posentegra_id = ? WHERE id = ?").run(incoming, restaurantId);
  const verified = db.prepare("SELECT id, posentegra_id FROM restaurants WHERE id = ?").get(restaurantId);
  if (!verified || verified.posentegra_id !== incoming) {
    logger.error("posentegra_id_db_verify_failed", {
      request_id: requestId,
      internal_restaurant_id: restaurantId,
      posentegra_id: incoming,
    });
    throw new Error("restaurants.posentegra_id DB dogrulamasi basarisiz.");
  }
  logger.info("posentegra_id_db_update_success", {
    request_id: requestId,
    internal_restaurant_id: restaurantId,
    posentegra_id: incoming,
  });
  return verified;
}

function posentegraStatusForPackageStatus(status) {
  const normalized = normalizeStatus(status);
  if (normalized === ACCEPTED_BY_COURIER_STATUS) return "accepted";
  if (normalized === ON_ROUTE_STATUS) return "on_the_way";
  if (normalized === DELIVERED_STATUS) return "delivered";
  if (normalized === FAILED_STATUS) return "failed";
  return normalized;
}

function triggerPosentegraOutbox() {
  posentegraOutbox.processDue().catch((error) => {
    logger.warn("Posentegra outbox sweep failed", { error });
  });
}

function schedulePosentegraOutbox() {
  queueMicrotask(triggerPosentegraOutbox);
}

function enqueuePosentegraPackageAssignment(pkg) {
  if (!posentegraClient.configured() || isPlatformBackedPackage(pkg)) {
    return null;
  }
  const restaurant = db.prepare("SELECT id, posentegra_id FROM restaurants WHERE id = ?").get(pkg.restaurantId);
  if (!restaurant?.posentegra_id) {
    logger.warn("Posentegra package assignment skipped", {
      packageId: pkg.id,
      restaurantId: pkg.restaurantId,
      reason: "restaurant_posentegra_id_missing",
    });
    return null;
  }
  const row = posentegraOutbox.enqueuePackageAssignment({
    packageId: pkg.id,
    restaurantPosentegraId: restaurant.posentegra_id,
    packagePayload: {
      externalOrderId: pkg.externalOrderId || pkg.externalOrderNo,
      trackingNo: pkg.trackingNo,
      customerName: pkg.recipient,
      recipient: pkg.recipient,
      phone: pkg.phone,
      deliveryAddress: pkg.deliveryAddress || pkg.address,
      packageType: pkg.packageType,
      source: pkg.source,
      sourcePlatform: pkg.sourcePlatform,
      orderAmount: normalizeMoney(pkg.orderAmount),
      paymentMethod: pkg.paymentMethod,
      paymentStatus: pkg.paymentStatus,
      items: Array.isArray(pkg.items) ? pkg.items : [],
      note: pkg.customerNote || pkg.note || "",
      createdAt: pkg.createdAt,
    },
  });
  schedulePosentegraOutbox();
  return row;
}

function enqueuePosentegraStatusChange(packageRow, nextStatus, req) {
  const normalized = normalizeStatus(nextStatus);
  if (!posentegraClient.configured() || ![ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, FAILED_STATUS].includes(normalized)) {
    return null;
  }
  const orderId = resolvePackagePosentegraId(packageRow);
  if (!orderId) {
    logger.warn("order_pid_missing_for_status_change", {
      request_id: req?.requestId || null,
      package_id: packageRow?.id || null,
      status: normalized,
    });
    return null;
  }
  const row = posentegraOutbox.enqueueStatus({
    packageId: packageRow.id,
    orderId,
    status: posentegraStatusForPackageStatus(normalized),
    meta: { internalStatus: normalized, requestId: req?.requestId || null },
  });
  schedulePosentegraOutbox();
  return row;
}

let posentegraInboundSyncRunning = false;

function posentegraRemoteStatus(responseBody = {}) {
  const data = responseBody?.data || responseBody;
  return data?.order?.status ?? data?.status ?? responseBody?.order?.status ?? responseBody?.status;
}

async function syncPosentegraInboundStatuses() {
  if (!posentegraClient.configured() || posentegraInboundSyncRunning) return { processed: 0, skipped: true };
  posentegraInboundSyncRunning = true;
  let processed = 0;
  let repaired = 0;
  try {
    const repairStamp = nowIso();
    const repairResult = db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = 'unassigned', assigned_courier_name = NULL,
          assigned_at = NULL, accepted_at = NULL, on_route_at = NULL,
          assignment_reason = ?, last_assignment_error = NULL, updated_at = ?
      WHERE assigned_courier_id IS NULL AND status IN (?, ?, ?)
    `).run(
      AWAITING_ASSIGNMENT_STATUS,
      'Kuryesiz ara durum onarildi; paket yeniden atama havuzuna alindi.',
      repairStamp,
      ASSIGNED_STATUS,
      ACCEPTED_BY_COURIER_STATUS,
      ON_ROUTE_STATUS
    );
    repaired = Number(repairResult.changes || 0);
    if (repaired > 0) logger.warn('Unassigned courier lifecycle states repaired', { repaired });
    const activeRows = db.prepare(`
      SELECT * FROM packages
      WHERE posentegra_id IS NOT NULL AND posentegra_id != ''
        AND status NOT IN (?, ?, ?, ?)
      ORDER BY datetime(updated_at) ASC
      LIMIT 100
    `).all(DELIVERED_STATUS, CANCELED_STATUS, REJECTED_STATUS, FAILED_STATUS);
    for (const row of activeRows) {
      try {
        const result = await posentegraClient.getOrder(row.posentegra_id);
        const remoteRawStatus = posentegraRemoteStatus(result.responseBody);
        if (remoteRawStatus === undefined || remoteRawStatus === null || remoteRawStatus === "") continue;
        const incomingStatus = mapOrderStatus(remoteRawStatus).status;
        if (!shouldApplyIncomingPlatformStatus(row.status, incomingStatus)) continue;
        updatePackageLifecycle(row.id, { status: incomingStatus }, {
          status: row.status,
          paymentMethod: row.payment_method,
          paymentStatus: row.payment_status,
          failureReason: row.failure_reason,
          assignedCourierId: row.assigned_courier_id,
          assignedCourierName: row.assigned_courier_name,
          assignedAt: row.assigned_at,
          acceptedAt: row.accepted_at,
          onRouteAt: row.on_route_at,
          deliveredAt: row.delivered_at,
          failedAt: row.failed_at,
          lastAssignmentAttemptAt: row.last_assignment_attempt_at,
          lastAssignmentError: row.last_assignment_error,
          paymentCollectedBy: row.payment_collected_by,
          collectedAmount: row.collected_amount,
          courierCollectionNote: row.courier_collection_note,
          orderAmount: row.order_amount,
        }, { skipPosentegraStatusSync: true });
        const updated = getPackageById(row.id);
        updatePlatformOrderStatusByPackage(updated || row, platformOrderStatusForPackageStatus(incomingStatus));
        broadcastLiveEvent({
          type: "package-status",
          restaurantId: row.restaurant_id,
          courierId: row.assigned_courier_id,
          message: `Platform siparis durumu ${incomingStatus} olarak guncellendi.`,
          orderId: row.id,
        });
        processed += 1;
      } catch (error) {
        logger.warn("Posentegra inbound status sync failed", {
          packageId: row.id,
          posentegraId: row.posentegra_id,
          error: error.message,
        });
      }
    }
    if (processed > 0 || repaired > 0) rebalancePackages();
    return { processed, repaired, selected: activeRows.length };
  } finally {
    posentegraInboundSyncRunning = false;
  }
}

function appendMissingAddressParts(baseAddress, parts) {
  const result = trimmed(baseAddress);
  if (!result) return "";
  const normalizedResult = result.toLocaleLowerCase("tr-TR");
  const missingParts = parts
    .map((part) => trimmed(part))
    .filter(Boolean)
    .filter((part, index, all) => all.findIndex((candidate) => candidate.toLocaleLowerCase("tr-TR") === part.toLocaleLowerCase("tr-TR")) === index)
    .filter((part) => !normalizedResult.includes(part.toLocaleLowerCase("tr-TR")));
  return [result, ...missingParts].join(", ");
}

function normalizeDeliveryAddressForGeocoding(value) {
  return trimmed(value)
    .replace(/\s+/g, " ")
    .replace(/\b(no|kat|daire|blok|apt)\s*[:.]?\s*(?=\d)/giu, "$1: ")
    .replace(/\b(\d{4,6})\s*\.?\s*sokak\b/giu, "$1. Sokak")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function deliveryAddressWithoutInteriorDetails(value) {
  return normalizeDeliveryAddressForGeocoding(value)
    .replace(/\b(?:kat|daire|blok|apt)\s*:\s*[\p{L}\d/-]+\b/giu, "")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,]+$/g, "")
    .trim();
}

function deliveryAddressLocality(value) {
  const normalized = normalizeDeliveryAddressForGeocoding(value);
  const neighborhood = normalized.match(/^(.+?\b(?:mahallesi|mah\.?))\b/iu)?.[1] || "";
  return trimmed(neighborhood);
}

function packageDeliveryAddressCandidates(pkg) {
  const defaultCity = trimmed(process.env.RESTOMAP_DEFAULT_CITY || process.env.GEOCODING_DEFAULT_CITY) || "Mersin";
  const defaultCountry = trimmed(process.env.RESTOMAP_DEFAULT_COUNTRY || process.env.GEOCODING_DEFAULT_COUNTRY) || "Türkiye";
  const address = normalizeDeliveryAddressForGeocoding(pkg.customer_address || pkg.delivery_address || pkg.address);
  const structuredAddress = [
    trimmed(pkg.street),
    trimmed(pkg.building_no) ? `No ${trimmed(pkg.building_no)}` : "",
    trimmed(pkg.floor) ? `Kat ${trimmed(pkg.floor)}` : "",
    trimmed(pkg.door_no) ? `Daire ${trimmed(pkg.door_no)}` : "",
  ].filter(Boolean).join(", ");
  const district = trimmed(pkg.district || pkg.zone);
  const city = trimmed(pkg.city) || defaultCity;
  const addressWithoutInteriorDetails = deliveryAddressWithoutInteriorDetails(address);
  const locality = deliveryAddressLocality(address);
  const bases = [structuredAddress, addressWithoutInteriorDetails, address].filter(Boolean);
  const candidates = [];
  for (const base of bases) {
    candidates.push(appendMissingAddressParts(base, [district, city, defaultCountry]));
    candidates.push(appendMissingAddressParts(base, [city, defaultCountry]));
  }
  if (locality) {
    candidates.push(appendMissingAddressParts(locality, [district, city, defaultCountry]));
    candidates.push(appendMissingAddressParts(locality, [city, defaultCountry]));
  }
  return candidates.filter(Boolean).filter((candidate, index, all) =>
    all.findIndex((item) => item.toLocaleLowerCase("tr-TR") === candidate.toLocaleLowerCase("tr-TR")) === index
  );
}

async function resolvePackageCustomerCoordinates(pkg) {
  const savedLatitude = Number(pkg.customer_lat);
  const savedLongitude = Number(pkg.customer_lng);
  const hasSavedCoordinates = pkg.customer_lat !== null && pkg.customer_lat !== "" &&
    pkg.customer_lng !== null && pkg.customer_lng !== "" &&
    coordinatesAreValid(savedLatitude, savedLongitude);
  if (hasSavedCoordinates) {
    return { latitude: savedLatitude, longitude: savedLongitude, cached: true };
  }

  const restaurantLatitude = Number(pkg.x);
  const restaurantLongitude = Number(pkg.y);
  const proximity = coordinatesAreValid(restaurantLatitude, restaurantLongitude)
    ? { latitude: restaurantLatitude, longitude: restaurantLongitude }
    : null;
  for (const candidate of packageDeliveryAddressCandidates(pkg)) {
    const coordinates = await geocodeDeliveryAddress(candidate, proximity);
    if (!coordinates) continue;
    db.prepare("UPDATE packages SET customer_lat = ?, customer_lng = ?, updated_at = ? WHERE id = ?")
      .run(coordinates.latitude, coordinates.longitude, nowIso(), pkg.id);
    return { ...coordinates, cached: false, query: candidate };
  }
  return null;
}

function enqueuePosentegraRestaurantDecision(packageRow, action, reason, req) {
  if (!packageRow || !isPlatformBackedPackage(packageRow) || !posentegraClient.configured()) {
    return null;
  }
  const sourcePlatform = normalizePlatformInput(packageRow.sourcePlatform || packageRow.source_platform);
  if (!["Trendyol Yemek", "Getir Yemek", "Yemeksepeti", "Migros Yemek"].includes(sourcePlatform)) {
    logger.info("posentegra_restaurant_decision_skipped", {
      request_id: req?.requestId || null,
      package_id: packageRow.id,
      source_platform: sourcePlatform || packageRow.sourcePlatform || packageRow.source_platform || null,
      reason: "unsupported_source_platform",
    });
    return null;
  }
  const orderId = resolvePackagePosentegraId(packageRow);
  if (!orderId) {
    logger.warn("order_pid_missing_for_restaurant_decision", {
      request_id: req?.requestId || null,
      package_id: packageRow.id,
      source_platform: sourcePlatform,
      action,
    });
    return null;
  }
  const meta = {
    sourcePlatform,
    decision: action,
    requestId: req?.requestId || null,
  };
  const row = action === "reject"
    ? posentegraOutbox.enqueueCancellation({
      packageId: packageRow.id,
      orderId,
      reason: trimmed(reason) || "Restoran siparişi reddetti.",
      meta,
    })
    : posentegraOutbox.enqueueStatus({
      packageId: packageRow.id,
      orderId,
      status: "accepted",
      meta: { ...meta, internalStatus: PREPARING_STATUS },
    });
  if (!row) {
    return null;
  }
  schedulePosentegraOutbox();
  appendPlatformStatusLog(packageRow.id, {
    status: action === "reject" ? "rejected" : "accepted",
    message: `${sourcePlatform} restoran ${action === "reject" ? "red" : "onay"} kararı Posentegra kuyruğuna alındı.`,
    platform: sourcePlatform,
    meta: {
      callbackMode: "posentegra_outbox",
      posentegraId: orderId,
      outboxId: row.id,
      eventType: row.event_type,
    },
  });
  logger.info("posentegra_restaurant_decision_queued", {
    request_id: req?.requestId || null,
    package_id: packageRow.id,
    posentegra_id: orderId,
    source_platform: sourcePlatform,
    action,
    outbox_id: row.id,
    outbox_status: row.status,
  });
  return row;
}

async function syncPosentegraStatusChangeOrThrow(packageRow, nextStatus, req) {
  if (!isPlatformBackedPackage(packageRow)) {
    return null;
  }
  if (!posentegraClient.configured()) {
    logger.info("posentegra_status_change_skipped", {
      request_id: req?.requestId || null,
      package_id: packageRow.id,
      status: nextStatus,
      reason: "posentegra_not_configured",
    });
    return null;
  }

  const orderId = trimmed(packageRow.posentegra_id);
  if (!orderId) {
    logger.warn("order_pid_missing_for_status_change", {
      request_id: req?.requestId || null,
      package_id: packageRow.id,
      internal_restaurant_id: packageRow.restaurant_id,
      platform_order_id: packageRow.external_order_id || packageRow.external_order_no || null,
      status: nextStatus,
    });
    throw validationError("Posentegra/FastSiparis order pid bulunamadigi icin durum degistirilemedi.");
  }

  const mappedStatus = posentegraStatusForPackageStatus(nextStatus);
  logger.info("posentegra_status_change_start", {
    request_id: req?.requestId || null,
    pid: orderId,
    posentegra_id: orderId,
    package_id: packageRow.id,
    platform_order_id: packageRow.external_order_id || packageRow.external_order_no || null,
    status: mappedStatus,
  });
  try {
    const result = await posentegraClient.changeOrderStatus(orderId, mappedStatus, {
      packageId: packageRow.id,
      internalStatus: normalizeStatus(nextStatus),
    });
    logger.info("posentegra_status_change_success", {
      request_id: req?.requestId || null,
      pid: orderId,
      posentegra_id: orderId,
      package_id: packageRow.id,
      platform_order_id: packageRow.external_order_id || packageRow.external_order_no || null,
      status: mappedStatus,
    });
    logPosentegraApiAttempt({
      requestId: req?.requestId || null,
      restaurantId: packageRow.restaurant_id,
      packageId: packageRow.id,
      event: "posentegra_status_change",
      responseStatus: result.status,
      requestBody: result.requestBody,
      responseBody: result.responseBody,
      externalRestaurantId: packageRow.platform_restaurant_id || null,
      externalOrderId: orderId,
      isMatched: true,
    });
    return result;
  } catch (error) {
    logger.error("posentegra_status_change_failed", {
      request_id: req?.requestId || null,
      pid: orderId,
      posentegra_id: orderId,
      package_id: packageRow.id,
      platform_order_id: packageRow.external_order_id || packageRow.external_order_no || null,
      status: mappedStatus,
      error_message: error.message,
    });
    logPosentegraApiAttempt({
      requestId: req?.requestId || null,
      restaurantId: packageRow.restaurant_id,
      packageId: packageRow.id,
      event: "posentegra_status_change_failed",
      responseStatus: error.result?.status || 502,
      requestBody: error.result?.requestBody || null,
      responseBody: error.result?.responseBody || null,
      error,
      externalRestaurantId: packageRow.platform_restaurant_id || null,
      externalOrderId: orderId,
      isMatched: true,
    });
    throw error;
  }
}

async function createRestaurantInPosentegraOrRollback(restaurant, requestId) {
  if (!posentegraClient.configured()) {
    logger.info("posentegra_restaurant_create_skipped", {
      request_id: requestId,
      internal_restaurant_id: restaurant.id,
      reason: "posentegra_not_configured",
    });
    return "";
  }

  logger.info("posentegra_restaurant_create_start", {
    request_id: requestId,
    internal_restaurant_id: restaurant.id,
    restaurant_name: restaurant.name,
    business_id: posentegraClient.businessId() || null,
  });

  let posentegraId = trimmed(restaurant.posentegraId);
  let remoteRestaurantCreated = false;
  try {
    if (posentegraId) {
      logger.info("posentegra_restaurant_create_skipped", {
        request_id: requestId,
        internal_restaurant_id: restaurant.id,
        posentegra_id: posentegraId,
        reason: "existing_posentegra_restaurant_id_provided",
      });
    } else {
      const createResult = await posentegraClient.createRestaurant(restaurant);
      logPosentegraApiAttempt({
        requestId,
        restaurantId: restaurant.id,
        event: "posentegra_restaurant_create",
        responseStatus: createResult.status,
        requestBody: createResult.requestBody,
        responseBody: createResult.responseBody,
      });
      posentegraId = extractPosentegraRestaurantId(createResult);
      if (!posentegraId) {
        throw new Error("Posentegra restoran create response icinde id bulunamadi.");
      }
      remoteRestaurantCreated = true;
    }
    const linkResult = await posentegraClient.linkRestaurantToBusiness(posentegraId);
    if (linkResult) {
      logPosentegraApiAttempt({
        requestId,
        restaurantId: restaurant.id,
        event: "posentegra_business_restaurant_link",
        responseStatus: linkResult.status,
        requestBody: linkResult.requestBody,
        responseBody: linkResult.responseBody,
        externalRestaurantId: posentegraId,
      });
    }
    updateRestaurantPosentegraIdOrThrow(restaurant.id, posentegraId, requestId);
    logger.info("posentegra_restaurant_create_success", {
      request_id: requestId,
      internal_restaurant_id: restaurant.id,
      posentegra_id: posentegraId,
    });
    return posentegraId;
  } catch (error) {
    logger.error("posentegra_restaurant_create_failed", {
      request_id: requestId,
      internal_restaurant_id: restaurant.id,
      error_message: error.message,
    });
    logPosentegraApiAttempt({
      requestId,
      restaurantId: restaurant.id,
      event: "posentegra_restaurant_create_failed",
      responseStatus: error.result?.status || 502,
      requestBody: error.result?.requestBody || null,
      responseBody: error.result?.responseBody || null,
      error,
    });
    if (remoteRestaurantCreated && posentegraId) {
      try {
        const rollbackResult = await posentegraClient.deleteRestaurant(posentegraId);
        logPosentegraApiAttempt({
          requestId,
          restaurantId: restaurant.id,
          event: "posentegra_restaurant_create_rollback",
          responseStatus: rollbackResult.status,
          requestBody: rollbackResult.requestBody,
          responseBody: rollbackResult.responseBody,
          externalRestaurantId: posentegraId,
        });
        logger.warn("posentegra_restaurant_create_rolled_back", {
          request_id: requestId,
          internal_restaurant_id: restaurant.id,
          posentegra_id: posentegraId,
        });
      } catch (rollbackError) {
        logger.error("posentegra_restaurant_create_rollback_failed", {
          request_id: requestId,
          internal_restaurant_id: restaurant.id,
          posentegra_id: posentegraId,
          error_message: rollbackError.message,
        });
        logPosentegraApiAttempt({
          requestId,
          restaurantId: restaurant.id,
          event: "posentegra_restaurant_create_rollback_failed",
          responseStatus: rollbackError.result?.status || 502,
          requestBody: rollbackError.result?.requestBody || null,
          responseBody: rollbackError.result?.responseBody || null,
          error: rollbackError,
          externalRestaurantId: posentegraId,
        });
      }
    }
    // Posentegra is an optional integration. A remote create/link failure must
    // not roll back the RESTOMAP restaurant account; the operator can match it
    // later from the unmatched-orders/integration screens.
    logger.warn("restaurant_created_without_posentegra_connection", {
      request_id: requestId,
      internal_restaurant_id: restaurant.id,
      error_message: error.message,
    });
    return "";
  }
}

function webhookPlatformLabel(slug, providerName = "") {
  const value = trimmed(slug || providerName).toLowerCase();
  if (["ys", "yemeksepeti", "yemek-sepeti", "yemek sepeti"].includes(value)) return "Yemeksepeti";
  if (value.includes("trendyol")) return "Trendyol Yemek";
  if (value.includes("getir")) return "Getir Yemek";
  if (value.includes("migros")) return "Migros Yemek";
  return normalizePlatformInput(value) || trimmed(providerName || slug) || "Diger";
}

function pickLocalizedText(value) {
  if (typeof value === "string") return trimmed(value);
  return trimmed(value?.tr || value?.en || value?.title?.tr || value?.title?.en);
}

function webhookOrderContent(payload = {}) {
  const candidates = [
    Array.isArray(payload.content) ? payload.content[0] : null,
    payload.data?.order,
    payload.data?.shipment,
    payload.order,
    payload.shipment,
    payload.data,
  ];
  const nested = candidates.find((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!nested || nested === payload) return payload;
  return {
    ...payload,
    ...nested,
    provider: nested.provider || payload.provider,
    restaurant: nested.restaurant || payload.restaurant,
  };
}

function extractWebhookRestaurantId(payload = {}) {
  const orderPayload = webhookOrderContent(payload);
  const store = orderPayload.store && typeof orderPayload.store === "object" ? orderPayload.store : {};
  return trimmed(
    orderPayload.restaurantId ||
    orderPayload.restaurant_id ||
    orderPayload.restaurant?.id ||
    orderPayload.provider?.restaurantId ||
    orderPayload.provider?.restaurant_id ||
    orderPayload.platformRestaurantId ||
    orderPayload.platform_restaurant_id ||
    orderPayload.externalRestaurantId ||
    orderPayload.external_restaurant_id ||
    orderPayload.branchId ||
    orderPayload.branch_id ||
    orderPayload.storeId ||
    orderPayload.store_id ||
    orderPayload.externalStoreId ||
    orderPayload.external_store_id ||
    orderPayload.merchantId ||
    orderPayload.merchant_id ||
    orderPayload.vendorId ||
    orderPayload.vendor_id ||
    orderPayload.sellerId ||
    orderPayload.seller_id ||
    orderPayload.supplierId ||
    orderPayload.supplier_id ||
    orderPayload.chainId ||
    orderPayload.chain_id ||
    store.id
  );
}

function normalizeWebhookOrderPayload(payload = {}) {
  const orderPayload = webhookOrderContent(payload);
  const provider = orderPayload.provider && typeof orderPayload.provider === "object" ? orderPayload.provider : {};
  const customer = orderPayload.customer && typeof orderPayload.customer === "object" ? orderPayload.customer : {};
  const client = orderPayload.client && typeof orderPayload.client === "object" ? orderPayload.client : customer;
  const deliveryAddress = client.deliveryAddress || orderPayload.deliveryAddress || orderPayload.shipmentAddress || orderPayload.address;
  const address = deliveryAddress && typeof deliveryAddress === "object" ? deliveryAddress : {};
  const locationSource = client.location || orderPayload.location || orderPayload.geo || {};
  const location = locationSource && typeof locationSource === "object" ? locationSource : {};
  const externalRestaurantId = extractWebhookRestaurantId(payload);
  const externalOrderId = trimmed(
    orderPayload.pid ||
    orderPayload.externalOrderId ||
    orderPayload.external_order_id ||
    orderPayload.orderId ||
    orderPayload.order_id ||
    orderPayload.externalOrderNo ||
    orderPayload.external_order_no ||
    orderPayload.orderNumber ||
    orderPayload.order_number ||
    orderPayload.id
  );
  const platformSlug = trimmed(provider.slug || provider.kaynak || provider.id || provider.alici || orderPayload.platformSlug || orderPayload.platform);
  const providerName = trimmed(provider.kaynak || provider.name || provider.alici || orderPayload.providerName || orderPayload.platform || platformSlug);
  const statusInfo = mapOrderStatus(orderPayload.status);
  const productsSource = orderPayload.products || orderPayload.items || orderPayload.lines;
  const products = Array.isArray(productsSource) ? productsSource : [];
  const addressText = trimmed(
    address.address ||
    address.address1 ||
    (typeof deliveryAddress === "string" ? deliveryAddress : "") ||
    client.address ||
    location.text ||
    orderPayload.addressText
  );
  const street = trimmed(address.street || address.address || address.address1);
  const fullAddress = [
    addressText,
    address.aptNo ? `No: ${address.aptNo}` : "",
    address.floor ? `Kat: ${address.floor}` : "",
    address.doorNo ? `Daire: ${address.doorNo}` : "",
    address.district,
    address.city,
  ].filter(Boolean).join(", ");

  return {
    externalOrderId,
    posentegraId: resolvePackagePosentegraId({
      pid: orderPayload.pid,
      posentegraId: orderPayload.posentegraId ?? orderPayload.posentegra_id,
      externalOrderId,
    }),
    confirmationId: trimmed(orderPayload.confirmationId || orderPayload.confirmation_id),
    externalRestaurantId,
    restaurantNameFromPayload: trimmed(orderPayload.restaurantName || orderPayload.restaurant?.name || orderPayload.store?.name),
    platform: webhookPlatformLabel(platformSlug, providerName),
    platformSlug,
    providerId: trimmed(provider.id),
    providerName,
    customerName: trimmed(client.name || customer.name || orderPayload.customerName || orderPayload.recipient),
    customerPhone: trimmed(client.clientPhoneNumber || client.phone || customer.phone || orderPayload.customerPhone || orderPayload.phone),
    contactPhone: trimmed(client.contactPhoneNumber || orderPayload.contactPhone || orderPayload.phone),
    addressText: fullAddress || addressText || "-",
    city: trimmed(address.city),
    district: trimmed(address.district),
    street,
    buildingNo: trimmed(address.aptNo || address.buildingNo),
    floor: trimmed(address.floor),
    doorNo: trimmed(address.doorNo),
    addressDescription: trimmed(address.description),
    latitude: Number.isFinite(Number(location.lat ?? location.latitude ?? orderPayload.latitude)) ? Number(location.lat ?? location.latitude ?? orderPayload.latitude) : null,
    longitude: Number.isFinite(Number(location.lon ?? location.lng ?? location.longitude ?? orderPayload.longitude)) ? Number(location.lon ?? location.lng ?? location.longitude ?? orderPayload.longitude) : null,
    status: statusInfo.status,
    statusText: statusInfo.statusText,
    rawStatus: statusInfo.rawStatus,
    totalPrice: normalizeMoney(orderPayload.totalPrice ?? orderPayload.totalAmount ?? orderPayload.orderAmount),
    discountedPrice: normalizeMoney(orderPayload.totalDiscountedPrice ?? orderPayload.discountedPrice),
    totalDiscount: normalizeMoney(orderPayload.totalDiscount),
    paymentMethod: trimmed(orderPayload.paymentMethod),
    paymentMethodText: pickLocalizedText(orderPayload.paymentMethodText),
    posPaymentMethod: trimmed(orderPayload.posPaymentMethod),
    posTicket: trimmed(orderPayload.pos_ticket || orderPayload.posTicket),
    clientNote: trimmed(orderPayload.clientNote || orderPayload.customerNote || orderPayload.note),
    shortCode: trimmed(orderPayload.shortCode),
    deliveryType: trimmed(orderPayload.deliveryType),
    isScheduled: Boolean(orderPayload.isScheduled),
    scheduledDate: trimmed(orderPayload.scheduledDate),
    products,
    rawPayload: payload,
  };
}

function isPosentegraWebhookPayload(payload = {}) {
  const orderPayload = webhookOrderContent(payload);
  const provider = orderPayload.provider && typeof orderPayload.provider === "object" ? orderPayload.provider : {};
  const providerApi = trimmed(provider.api);
  const restaurantId = extractWebhookRestaurantId(payload);
  const orderId = trimmed(orderPayload.pid || orderPayload.posentegraId || orderPayload.posentegra_id);
  return Boolean(providerApi && restaurantId && orderId);
}

function restaurantMatchesExternalId(restaurant, externalRestaurantId, platform = "") {
  const incoming = trimmed(externalRestaurantId);
  if (!incoming) return false;
  const platformKey = trimmed(platform).toLowerCase();
  if (restaurant.trendyolRestaurantId === incoming && platformKey.includes("trendyol")) return true;
  if (restaurant.yemeksepetiRestaurantId === incoming && (platformKey.includes("yemek") || platformKey === "ys")) return true;
  if (restaurant.getirRestaurantId === incoming && platformKey.includes("getir")) return true;
  if (restaurant.migrosRestaurantId === incoming && platformKey.includes("migros")) return true;
  if (restaurant.posentegraId === incoming) return true;
  if ([restaurant.trendyolRestaurantId, restaurant.yemeksepetiRestaurantId, restaurant.getirRestaurantId, restaurant.migrosRestaurantId].includes(incoming)) return true;
  return (restaurant.externalRestaurantIds || []).some((item) => item.restaurantId === incoming);
}

function findRestaurantByExternalRestaurantId(externalRestaurantId, platform = "") {
  return getRestaurants().find((restaurant) => restaurantMatchesExternalId(restaurant, externalRestaurantId, platform)) || null;
}

function apiWebhookAuthorized(req, order = {}) {
  const secretHeaders = [
    req.headers["x-webhook-secret"],
    req.headers["x-platform-secret"],
    req.headers["x-api-key"],
    getBearerToken(req),
  ];
  if (WEBHOOK_SECRET && secretHeaders.some((value) => timingSafeStringEqual(value, WEBHOOK_SECRET))) {
    return true;
  }

  const bearer = getBearerToken(req);
  const externalRestaurantId = trimmed(order.externalRestaurantId);
  return Boolean(bearer && externalRestaurantId && bearer === externalRestaurantId);
}

function applyWebhookRestaurantIdFallback(req, order = {}) {
  if (order.externalRestaurantId) {
    return order;
  }
  const bearer = getBearerToken(req);
  const bearerIsGlobalSecret = WEBHOOK_SECRET && timingSafeStringEqual(bearer, WEBHOOK_SECRET);
  if (bearer && !bearerIsGlobalSecret) {
    order.externalRestaurantId = bearer;
  }
  return order;
}

function webhookPosTicketForPackage(pkg, fallbackId = "", order = {}) {
  return String(order?.posTicket || order?.pos_ticket || pkg?.posTicket || pkg?.pos_ticket || fallbackId || pkg?.id || "");
}

function findWebhookPackageForOrder(order, restaurantId) {
  return db.prepare(`
    SELECT * FROM packages
    WHERE restaurant_id = ?
      AND (
        (external_order_id IS NOT NULL AND external_order_id != '' AND external_order_id = ?)
        OR (external_order_no IS NOT NULL AND external_order_no != '' AND external_order_no = ?)
        OR (confirmation_id IS NOT NULL AND confirmation_id != '' AND confirmation_id = ?)
        OR (posentegra_id IS NOT NULL AND posentegra_id != '' AND posentegra_id = ?)
      )
    ORDER BY datetime(created_at) DESC
  `).get(
    restaurantId,
    order.externalOrderId || "",
    order.externalOrderId || "",
    order.confirmationId || "",
    order.posentegraId || ""
  );
}

function externalApiAuthorized(req) {
  const expected = trimmed(process.env.DELIVERA_INTEGRATION_KEY);
  const bearer = getBearerToken(req);
  const headerKey = trimmed(req.headers["x-integration-key"] || req.headers["x-api-key"]);
  return Boolean(expected) && (bearer === expected || headerKey === expected);
}

function requireExternalApiKey(req, res) {
  if (externalApiAuthorized(req)) {
    return true;
  }
  sendJson(res, 401, { error: "External API key required." });
  return false;
}

function platformApiKey(platform) {
  const normalized = normalizePlatformInput(platform) || trimmed(platform);
  const slug = platformSlug(normalized || platform);
  if (slug.includes("trendyol")) return "trendyol";
  if (slug.includes("getir")) return "getir";
  if (slug.includes("yemek")) return "yemeksepeti";
  if (slug.includes("migros")) return "migros";
  if (slug.includes("pos")) return "pos";
  return slug || "external_api";
}

function externalStatusFromInternal(status) {
  const normalized = normalizeStatus(status);
  if ([PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(normalized)) return "waiting_assignment";
  if (normalized === ASSIGNED_STATUS) return "assigned";
  if (normalized === ACCEPTED_BY_COURIER_STATUS) return "picked_up";
  if (normalized === ON_ROUTE_STATUS) return "on_the_way";
  if (normalized === DELIVERED_STATUS) return "delivered";
  if (normalized === CANCELED_STATUS || normalized === REJECTED_STATUS) return "cancelled";
  if (normalized === FAILED_STATUS) return "failed";
  return "waiting_assignment";
}

function internalStatusFromExternal(status) {
  const incoming = trimmed(status).toLowerCase();
  const map = {
    waiting_assignment: AWAITING_ASSIGNMENT_STATUS,
    assigned: ASSIGNED_STATUS,
    picked_up: ACCEPTED_BY_COURIER_STATUS,
    on_the_way: ON_ROUTE_STATUS,
    delivered: DELIVERED_STATUS,
    cancelled: CANCELED_STATUS,
    canceled: CANCELED_STATUS,
    failed: FAILED_STATUS,
  };
  return map[incoming] || normalizeStatus(incoming);
}

function isKnownExternalPackageStatus(status) {
  const incoming = trimmed(status).toLowerCase();
  return [
    "waiting_assignment",
    "assigned",
    "picked_up",
    "on_the_way",
    "delivered",
    "cancelled",
    "canceled",
    "failed",
  ].includes(incoming) || isKnownPackageStatus(incoming);
}

function externalRestaurantPayload(restaurant) {
  return {
    id: restaurant.id,
    name: restaurant.name,
    trendyolRestaurantId: restaurant.trendyolRestaurantId || "",
    getirRestaurantId: restaurant.getirRestaurantId || "",
    yemeksepetiRestaurantId: restaurant.yemeksepetiRestaurantId || "",
    migrosRestaurantId: restaurant.migrosRestaurantId || "",
    posentegraId: restaurant.posentegraId || "",
    otherPlatformIds: restaurant.externalRestaurantIds || [],
  };
}

function externalPackagePayload(pkg) {
  return {
    id: pkg.id,
    trackingNo: pkg.trackingNo,
    restaurantId: pkg.restaurantId,
    restaurantName: pkg.restaurantName || "",
    platform: platformApiKey(pkg.platform || pkg.sourcePlatform || pkg.source),
    platformRestaurantId: pkg.platformRestaurantId || "",
    posentegraId: pkg.posentegraId || "",
    platformOrderId: pkg.platformOrderId || pkg.externalOrderId || pkg.externalOrderNo || "",
    status: externalStatusFromInternal(pkg.status),
    courierId: pkg.assignedCourierId || null,
    deliveryAddress: pkg.deliveryAddress || pkg.address || "",
    createdAt: pkg.createdAt,
    rawPayload: pkg.rawPayload || null,
  };
}

function normalizeExternalPlatformOrderBody(body = {}) {
  const platform = normalizePlatformInput(body.platform) || trimmed(body.platform);
  const platformOrderId = trimmed(body.platformOrderId ?? body.platform_order_id ?? body.orderId ?? body.order_id ?? body.externalOrderId ?? body.external_order_id);
  const posentegraId = resolvePackagePosentegraId({
    pid: body.pid,
    posentegraId: body.posentegraId ?? body.posentegra_id,
    externalOrderId: platformOrderId,
  });
  const platformRestaurantId = trimmed(
    body.platformRestaurantId ??
    body.platform_restaurant_id ??
    body.externalRestaurantId ??
    body.external_restaurant_id ??
    body.restaurantId ??
    body.restaurant_id ??
    body.restaurant?.id ??
    posentegraId
  );
  const deliveryAddress = trimmed(body.deliveryAddress ?? body.delivery_address ?? body.address);
  const customerName = trimmed(body.customerName ?? body.customer_name ?? body.recipient);
  const customerPhone = trimmed(body.customerPhone ?? body.customer_phone ?? body.phone);
  const totalAmount = normalizeMoney(body.totalAmount ?? body.total_amount ?? body.totalPrice ?? body.total_price ?? body.orderAmount ?? body.order_amount);
  if (!platform || !platformRestaurantId || !platformOrderId || !deliveryAddress || !customerName || !customerPhone || totalAmount <= 0) {
    throw validationError("platform, platformRestaurantId, platformOrderId, customerName, customerPhone, deliveryAddress ve totalAmount zorunludur.");
  }
  return {
    platform,
    platformKey: platformApiKey(platform),
    posentegraId,
    platformRestaurantId,
    platformOrderId,
    customerName,
    customerPhone,
    deliveryAddress,
    items: normalizeIncomingOrderItems(body.items),
    totalAmount,
    customerNote: trimmed(body.customerNote ?? body.customer_note ?? body.note),
    paymentMethod: trimmed(body.paymentMethod ?? body.payment_method) || "Platform Odeme",
    rawPayload: body.rawPayload ?? body.raw_payload ?? body,
  };
}

function createOrGetExternalPlatformOrder(body, req) {
  const order = normalizeExternalPlatformOrderBody(body);
  logger.info("external_platform_order_received", {
    request_id: req.requestId,
    platform: order.platformKey,
    platform_restaurant_id: order.platformRestaurantId,
    platform_order_id: order.platformOrderId,
    pid: order.posentegraId || null,
    posentegra_id: order.posentegraId || null,
  });
  if (order.posentegraId) {
    logger.info("posentegra_id_detected", {
      request_id: req.requestId,
      pid: order.posentegraId,
      posentegra_id: order.posentegraId,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      platform_order_id: order.platformOrderId,
    });
  }
  const restaurant = findRestaurantByExternalRestaurantId(order.platformRestaurantId, order.platform);
  if (!restaurant) {
    logger.warn("platform_restaurant_not_matched", {
      request_id: req.requestId,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      provider_slug: order.platformKey,
      pid: order.posentegraId || null,
      posentegra_id: order.posentegraId || null,
    });
    logger.warn("platform_restaurant_match_failed", {
      request_id: req.requestId,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      platform_order_id: order.platformOrderId,
    });
    const unmatchedOrder = canonicalPlatformOrderToUnmatched(order, body);
    const unmatchedOrderId = persistUnmatchedIncomingOrder(unmatchedOrder, req);
    return {
      unmatched: true,
      unmatchedOrderId,
      duplicate: false,
      platformOrder: null,
      package: null,
    };
  }
  logger.info("platform_restaurant_matched", {
    request_id: req.requestId,
    internal_restaurant_id: restaurant.id,
    platform: order.platformKey,
    platform_restaurant_id: order.platformRestaurantId,
    platform_order_id: order.platformOrderId,
    pid: order.posentegraId || null,
    posentegra_id: order.posentegraId || null,
  });
  if (order.posentegraId) {
    logger.info("posentegra_restaurant_matched", {
      request_id: req.requestId,
      pid: order.posentegraId,
      posentegra_id: order.posentegraId,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      internal_restaurant_id: restaurant.id,
      platform_order_id: order.platformOrderId,
    });
  }

  let platformOrderId;
  let packageId;
  let duplicate = false;
  dbFacade.transaction(() => {
    platformOrderId = upsertPlatformOrderRecord({
      platform: order.platform,
      platformRestaurantId: order.platformRestaurantId,
      posentegraId: order.posentegraId,
      platformOrderId: order.platformOrderId,
      orderId: order.platformOrderId,
      customerName: order.customerName,
      phone: order.customerPhone,
      address: order.deliveryAddress,
      totalPrice: order.totalAmount,
      customerNote: order.customerNote,
      rawPayload: order.rawPayload,
    }, restaurant.id, "approved", { requestId: req.requestId, platformRestaurantId: order.platformRestaurantId, posentegraId: order.posentegraId });

    const existingOrder = db.prepare("SELECT * FROM platform_orders WHERE id = ?").get(platformOrderId);
    if (existingOrder?.package_id) {
      const existingPackage = db.prepare("SELECT id FROM packages WHERE id = ?").get(existingOrder.package_id);
      if (existingPackage) {
        packageId = existingPackage.id;
        duplicate = true;
        return;
      }
    }

    const duplicatePackage = findDuplicatePackage(restaurant.id, order.platformKey, order.platformOrderId, order.posentegraId) ||
      db.prepare("SELECT * FROM packages WHERE restaurant_id = ? AND external_order_id = ?").get(restaurant.id, order.platformOrderId);
    if (duplicatePackage) {
      packageId = duplicatePackage.id;
      updatePlatformOrderPackageId(platformOrderId, packageId, req.requestId);
      duplicate = true;
      return;
    }

    const pkg = validateIntegrationDraft({
      restaurantId: restaurant.id,
      source: order.platformKey,
      sourcePlatform: order.platformKey,
      platformRestaurantId: order.platformRestaurantId,
      externalRestaurantId: order.platformRestaurantId,
      posentegraId: order.posentegraId,
      externalOrderNo: order.platformOrderId,
      externalOrderId: order.platformOrderId,
      recipient: order.customerName,
      phone: order.customerPhone,
      address: order.deliveryAddress,
      customerAddress: order.deliveryAddress,
      zone: restaurant.zone,
      paymentMethod: order.paymentMethod,
      orderAmount: order.totalAmount,
      items: order.items,
      note: order.customerNote || "External API siparisi",
      customerNote: order.customerNote,
      rawPayload: order.rawPayload,
      status: AWAITING_ASSIGNMENT_STATUS,
    }, restaurant);
    createPackageRecord(pkg, "Platform Siparisi", { requestId: req.requestId });
    assertPersistedRecord("packages", pkg.id, "package_created", req.requestId);
    updatePackageApiMetadata(pkg.id, {
      externalRestaurantId: order.platformRestaurantId,
      externalOrderId: order.platformOrderId,
      platformSlug: order.platformKey,
      providerName: order.platformKey,
      contactPhone: order.customerPhone,
      rawPayload: order.rawPayload,
    });
    replaceOrderItems(pkg.id, order.items);
    updatePlatformOrderPackageId(platformOrderId, pkg.id, req.requestId);
    packageId = pkg.id;
  });

  const platformOrder = getPlatformOrderById(platformOrderId);
  const pkg = getPackageById(packageId);
  if (!duplicate) {
    logger.info("platform_order_created", {
      request_id: req.requestId,
      internal_restaurant_id: restaurant.id,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      platform_order_id: order.platformOrderId,
      pid: order.posentegraId || null,
      posentegra_id: order.posentegraId || null,
      package_id: packageId,
      tracking_no: pkg?.trackingNo || null,
    });
    logger.info("package_created", {
      request_id: req.requestId,
      internal_restaurant_id: restaurant.id,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      platform_order_id: order.platformOrderId,
      pid: order.posentegraId || null,
      posentegra_id: order.posentegraId || null,
      package_id: packageId,
      tracking_no: pkg?.trackingNo || null,
    });
  }
  if (order.posentegraId) {
    logger.info(duplicate ? "posentegra_duplicate_skipped" : "posentegra_order_created", {
      request_id: req.requestId,
      pid: order.posentegraId,
      posentegra_id: order.posentegraId,
      internal_restaurant_id: restaurant.id,
      platform: order.platformKey,
      platform_restaurant_id: order.platformRestaurantId,
      platform_order_id: order.platformOrderId,
      package_id: packageId,
    });
  }
  logger.info(duplicate ? "external_platform_order_duplicate" : "external_platform_order_persisted", {
    request_id: req.requestId,
    internal_restaurant_id: restaurant.id,
    platform: order.platformKey,
    platform_restaurant_id: order.platformRestaurantId,
    platform_order_id: order.platformOrderId,
    pid: order.posentegraId || null,
    posentegra_id: order.posentegraId || null,
    package_id: packageId,
    tracking_no: pkg?.trackingNo || null,
  });
  return {
    duplicate,
    platformOrder,
    package: pkg,
  };
}

function apiPackageDraftFromWebhook(order, restaurant) {
  return {
    restaurantId: restaurant.id,
    source: "platform_webhook",
    sourcePlatform: order.platform,
    platformRestaurantId: order.externalRestaurantId,
    externalRestaurantId: order.externalRestaurantId,
    posentegraId: order.posentegraId,
    externalOrderNo: order.externalOrderId || order.confirmationId || `WEBHOOK-${Date.now()}`,
    externalOrderId: order.externalOrderId || order.confirmationId,
    recipient: order.customerName || "Musteri",
    phone: order.customerPhone || order.contactPhone || "-",
    address: order.addressText || "-",
    zone: restaurant.zone,
    paymentMethod: order.paymentMethodText || order.posPaymentMethod || order.paymentMethod || "Platform Odeme",
    orderAmount: order.discountedPrice || order.totalPrice,
    customerNote: order.clientNote,
    customerLatitude: order.latitude,
    customerLongitude: order.longitude,
    customerAddress: order.addressText,
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
    rawPayload: order.rawPayload,
    items: order.products.map((item) => ({
      id: trimmed(item.id),
      productId: trimmed(item.product),
      name: pickLocalizedText(item.name) || pickLocalizedText(item.displayInfo) || "Urun",
      quantity: normalizeMoney(item.count ?? item.quantity, 1),
      price: normalizeMoney(item.price),
      optionPrice: normalizeMoney(item.optionPrice),
      priceWithOption: normalizeMoney(item.priceWithOption ?? item.price),
      totalPrice: normalizeMoney(item.totalPrice),
      note: trimmed(item.note),
    })),
    note: order.clientNote ? `Platform notu: ${order.clientNote}` : "Platform webhook siparisi alindi.",
    status: order.posentegraId
      ? AWAITING_ASSIGNMENT_STATUS
      : (order.status === "pending" ? PENDING_STATUS : normalizeStatus(order.status)),
    assignmentStatus: order.posentegraId ? "unassigned" : "pending",
    assignmentReason: order.posentegraId
      ? "Posentegra siparisi dogrudan kurye atama havuzuna alindi."
      : "Platform webhook siparisi alindi, restoran onayi bekliyor.",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function updatePackageApiMetadata(packageId, order) {
  const platformRestaurantId = order.platformRestaurantId || order.externalRestaurantId || "";
  db.prepare(`
    UPDATE packages
    SET platform_restaurant_id = COALESCE(NULLIF(?, ''), platform_restaurant_id),
        posentegra_id = COALESCE(NULLIF(?, ''), posentegra_id),
        confirmation_id = ?, external_restaurant_id = ?, restaurant_name_from_payload = ?, platform_slug = ?,
        provider_id = ?, provider_name = ?, contact_phone = ?, city = ?, district = ?, street = ?,
        building_no = ?, floor = ?, door_no = ?, address_description = ?, status_text = ?, raw_status = ?,
        discounted_price = ?, total_discount = ?, pos_payment_method = ?, pos_ticket = ?, short_code = ?,
        delivery_type = ?, is_scheduled = ?, scheduled_date = ?, raw_payload_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    platformRestaurantId,
    order.posentegraId || "",
    order.confirmationId || null,
    order.externalRestaurantId || order.platformRestaurantId || null,
    order.restaurantNameFromPayload || null,
    order.platformSlug || null,
    order.providerId || null,
    order.providerName || null,
    order.contactPhone || null,
    order.city || null,
    order.district || null,
    order.street || null,
    order.buildingNo || null,
    order.floor || null,
    order.doorNo || null,
    order.addressDescription || null,
    order.statusText || null,
    order.rawStatus || null,
    order.discountedPrice || null,
    order.totalDiscount || null,
    order.posPaymentMethod || null,
    order.posTicket || null,
    order.shortCode || null,
    order.deliveryType || null,
    order.isScheduled ? 1 : 0,
    order.scheduledDate || null,
    json(order.rawPayload || null),
    nowIso(),
    packageId
  );
  const verified = db.prepare("SELECT id, restaurant_id, platform_restaurant_id, posentegra_id, external_order_id FROM packages WHERE id = ?").get(packageId);
  if (platformRestaurantId && verified?.platform_restaurant_id === platformRestaurantId) {
    logger.info("package_platform_restaurant_id_saved", {
      package_id: packageId,
      internal_restaurant_id: verified.restaurant_id,
      platform_restaurant_id: platformRestaurantId,
      pid: order.posentegraId || null,
      posentegra_id: order.posentegraId || null,
      platform_order_id: order.externalOrderId || order.confirmationId || verified.external_order_id || null,
    });
  }
  if (order.posentegraId) {
    logger.info("order_pid_linked", {
      package_id: packageId,
      internal_restaurant_id: verified?.restaurant_id || null,
      pid: order.posentegraId,
      posentegra_id: order.posentegraId,
      platform_restaurant_id: platformRestaurantId || verified?.platform_restaurant_id || null,
      platform_order_id: order.externalOrderId || order.confirmationId || verified?.external_order_id || null,
    });
  }
}

function replaceOrderItems(packageId, products = []) {
  const stamp = nowIso();
  db.prepare("DELETE FROM order_items WHERE order_id = ?").run(packageId);
  products.forEach((item) => {
    const name = pickLocalizedText(item.name) || pickLocalizedText(item.displayInfo) || "Urun";
    db.prepare(`
      INSERT INTO order_items (
        id, order_id, external_product_id, product_id, name, quantity, price, option_price, price_with_option,
        total_price, total_option_price, total_price_with_option, note, removed_ingredients, extra_ingredients,
        raw_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid("itm"),
      packageId,
      trimmed(item.id) || null,
      trimmed(item.product || item.productId) || null,
      name,
      normalizeMoney(item.count ?? item.quantity, 1),
      normalizeMoney(item.price),
      normalizeMoney(item.optionPrice),
      normalizeMoney(item.priceWithOption ?? item.price),
      normalizeMoney(item.totalPrice),
      normalizeMoney(item.totalOptionPrice),
      normalizeMoney(item.totalPriceWithOption ?? item.totalPrice),
      trimmed(item.note) || null,
      json(item.removedIngredients || []),
      json(item.extraIngredients || []),
      json(item),
      stamp,
      stamp
    );
  });
}

function logPlatformRestaurantNotMatched(order, req = null) {
  logger.warn("platform_restaurant_not_matched", {
    request_id: req?.requestId || null,
    platform: platformApiKey(order.platform || order.platformSlug || order.providerName),
    platform_restaurant_id: order.externalRestaurantId || null,
    provider_slug: order.platformSlug || null,
    platform_order_id: order.externalOrderId || order.confirmationId || null,
    pid: order.posentegraId || null,
    posentegra_id: order.posentegraId || null,
  });
}

function isHistoricalWebhookReplay(order = {}) {
  const sourceDate = Date.parse(order.rawPayload?.created_at || order.rawPayload?.createdAt || "");
  return Number.isFinite(sourceDate) && Date.now() - sourceDate > 30 * 24 * 60 * 60 * 1000;
}

function upsertWebhookPackage(order, restaurant, options = {}) {
  if (order.posentegraId) {
    logger.info("order_pid_detected", {
      request_id: options.requestId || null,
      pid: order.posentegraId,
      posentegra_id: order.posentegraId,
      platform_restaurant_id: order.externalRestaurantId || null,
      internal_restaurant_id: restaurant.id,
      platform_order_id: order.externalOrderId || order.confirmationId || null,
    });
  }
  const existing = db.prepare(`
    SELECT * FROM packages
    WHERE restaurant_id = ?
      AND (
        (external_order_id IS NOT NULL AND external_order_id != '' AND external_order_id = ?)
        OR (confirmation_id IS NOT NULL AND confirmation_id != '' AND confirmation_id = ?)
        OR (posentegra_id IS NOT NULL AND posentegra_id != '' AND posentegra_id = ?)
      )
    ORDER BY datetime(created_at) DESC
  `).get(restaurant.id, order.externalOrderId || "", order.confirmationId || "", order.posentegraId || "");

  if (existing) {
    const historicalReplay = isHistoricalWebhookReplay(order);
    const existingStatus = normalizeStatus(existing.status);
    const shouldReopenExisting = historicalReplay || (order.status === "pending" && [CANCELED_STATUS, REJECTED_STATUS, FAILED_STATUS].includes(existingStatus));
    const nextStatus = historicalReplay
      ? (order.posentegraId ? AWAITING_ASSIGNMENT_STATUS : PENDING_APPROVAL_STATUS)
      : (shouldReopenExisting ? PENDING_STATUS : (order.status === "pending" ? existingStatus : normalizeStatus(order.status)));
    const nextAssignmentStatus = historicalReplay
      ? (order.posentegraId ? "unassigned" : "pending_approval")
      : (shouldReopenExisting ? assignmentStatusForOrder(nextStatus) : (existing.assignment_status || assignmentStatusForOrder(existing.status)));
    logger.warn("INSERT_SKIPPED", {
      requestId: options.requestId || null,
      tableName: "platform_orders",
      reason: "existing_platform_order_updated_instead",
      existingId: existing.id,
      platform: order.platform,
      platformOrderId: order.externalOrderId || order.confirmationId || null,
      platformRestaurantId: order.externalRestaurantId || null,
      posentegraId: order.posentegraId || null,
      restaurantId: restaurant.id,
    });
    db.prepare(`
      UPDATE packages
      SET source_platform = ?, external_order_no = ?, recipient = ?, phone = ?, address = ?, delivery_address = ?,
          payment_method = ?, order_amount = ?, customer_lat = ?, customer_lng = ?, customer_address = ?,
          customer_note = ?, note = ?, items_json = ?,
          platform_restaurant_id = COALESCE(NULLIF(?, ''), platform_restaurant_id),
          posentegra_id = COALESCE(NULLIF(?, ''), posentegra_id), updated_at = ?
      WHERE id = ?
    `).run(
      order.platform,
      order.externalOrderId || order.confirmationId || existing.external_order_no,
      order.customerName || existing.recipient,
      order.customerPhone || order.contactPhone || existing.phone,
      order.addressText || existing.address,
      order.addressText || existing.delivery_address || existing.address,
      order.paymentMethodText || order.posPaymentMethod || order.paymentMethod || existing.payment_method,
      order.discountedPrice || order.totalPrice || existing.order_amount,
      order.latitude,
      order.longitude,
      order.addressText || existing.customer_address,
      order.clientNote || existing.customer_note,
      order.clientNote ? `Platform notu: ${order.clientNote}` : existing.note,
      json(apiPackageDraftFromWebhook(order, restaurant).items),
      order.externalRestaurantId || "",
      order.posentegraId || "",
      nowIso(),
      existing.id
    );
    if (!historicalReplay && shouldApplyIncomingPlatformStatus(existingStatus, nextStatus)) {
      updatePackageLifecycle(existing.id, {
        status: nextStatus,
        assignmentStatus: nextAssignmentStatus,
      }, {
        status: existing.status,
        paymentMethod: existing.payment_method,
        paymentStatus: existing.payment_status,
        failureReason: existing.failure_reason,
        assignedCourierId: existing.assigned_courier_id,
        assignedCourierName: existing.assigned_courier_name,
        assignedAt: existing.assigned_at,
        acceptedAt: existing.accepted_at,
        onRouteAt: existing.on_route_at,
        deliveredAt: existing.delivered_at,
        failedAt: existing.failed_at,
        lastAssignmentAttemptAt: existing.last_assignment_attempt_at,
        lastAssignmentError: existing.last_assignment_error,
        paymentCollectedBy: existing.payment_collected_by,
        collectedAmount: existing.collected_amount,
        courierCollectionNote: existing.courier_collection_note,
        orderAmount: existing.order_amount,
      }, { skipPosentegraStatusSync: true });
    }
    if (historicalReplay) {
      const replayedAt = nowIso();
      db.prepare(`
        UPDATE packages
        SET assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL, accepted_at = NULL,
            on_route_at = NULL, delivered_at = NULL, failed_at = NULL, distance_km = NULL,
            assignment_reason = ?, failure_reason = NULL, last_assignment_attempt_at = NULL,
            last_assignment_error = NULL, assignment_tried_courier_ids_json = '[]', created_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        order.posentegraId
          ? "Test Posentegra siparisi yeniden kurye atama havuzuna alindi."
          : "Test siparisi yeniden restoran onay havuzuna alindi.",
        replayedAt,
        replayedAt,
        existing.id
      );
      logger.info("historical_webhook_replayed_as_new", {
        request_id: options.requestId || null,
        package_id: existing.id,
        platform_order_id: order.externalOrderId || order.confirmationId || null,
        source_created_at: order.rawPayload?.created_at || order.rawPayload?.createdAt || null,
        replayed_at: replayedAt,
      });
    }
    updatePackageApiMetadata(existing.id, order);
    replaceOrderItems(existing.id, order.products);
    upsertPlatformOrderRecord({
      platform: order.platform,
      platformRestaurantId: order.externalRestaurantId,
      externalRestaurantId: order.externalRestaurantId,
      posentegraId: order.posentegraId,
      orderId: order.externalOrderId || order.confirmationId,
      packageId: existing.id,
      customerName: order.customerName,
      phone: order.customerPhone || order.contactPhone,
      address: order.addressText,
      totalPrice: order.discountedPrice || order.totalPrice,
      customerNote: order.clientNote,
      rawPayload: order.rawPayload,
    }, restaurant.id, platformOrderStatusForPackageStatus(
      getPackageById(existing.id)?.status || nextStatus,
      order.posentegraId ? "approved" : (order.statusText || "pending_approval")
    ), {
      requestId: options.requestId || null,
      platformRestaurantId: order.externalRestaurantId,
      posentegraId: order.posentegraId,
      packageId: existing.id,
    });
    if (order.posentegraId) {
      logger.info("order_pid_duplicate_skipped", {
        request_id: options.requestId || null,
        pid: order.posentegraId,
        posentegra_id: order.posentegraId,
        platform: platformApiKey(order.platform),
        platform_restaurant_id: order.externalRestaurantId || null,
        internal_restaurant_id: restaurant.id,
        package_id: existing.id,
        platform_order_id: order.externalOrderId || order.confirmationId || null,
      });
      logger.info("posentegra_duplicate_skipped", {
        request_id: options.requestId || null,
        pid: order.posentegraId,
        posentegra_id: order.posentegraId,
        platform: platformApiKey(order.platform),
        platform_restaurant_id: order.externalRestaurantId || null,
        internal_restaurant_id: restaurant.id,
        package_id: existing.id,
        platform_order_id: order.externalOrderId || order.confirmationId || null,
      });
    }
    return { packageId: existing.id, duplicate: !historicalReplay, replayed: historicalReplay };
  }

  const draft = apiPackageDraftFromWebhook(order, restaurant);
  const pkg = validateIntegrationDraft(draft, {
    id: restaurant.id,
    zone: restaurant.zone,
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
  });
  pkg.status = draft.status;
  pkg.assignmentStatus = draft.assignmentStatus;
  pkg.assignmentReason = draft.assignmentReason;
  createPackageRecord(pkg, "Platform Siparisi", { requestId: null });
  assertPersistedRecord("packages", pkg.id, "package_created", null);
  updatePackageApiMetadata(pkg.id, order);
  replaceOrderItems(pkg.id, order.products);
  upsertPlatformOrderRecord({
    platform: order.platform,
    platformRestaurantId: order.externalRestaurantId,
    externalRestaurantId: order.externalRestaurantId,
    posentegraId: order.posentegraId,
    orderId: order.externalOrderId || order.confirmationId,
    packageId: pkg.id,
    customerName: order.customerName,
    phone: order.customerPhone || order.contactPhone,
    address: order.addressText,
    totalPrice: order.discountedPrice || order.totalPrice,
    customerNote: order.clientNote,
    rawPayload: order.rawPayload,
  }, restaurant.id, order.posentegraId ? "approved" : (order.statusText || "pending_approval"), {
    requestId: options.requestId || null,
    platformRestaurantId: order.externalRestaurantId,
    posentegraId: order.posentegraId,
    packageId: pkg.id,
  });
  if (order.posentegraId) {
    logger.info("posentegra_order_created", {
      request_id: options.requestId || null,
      pid: order.posentegraId,
      posentegra_id: order.posentegraId,
      platform: platformApiKey(order.platform),
      platform_restaurant_id: order.externalRestaurantId || null,
      internal_restaurant_id: restaurant.id,
      package_id: pkg.id,
      platform_order_id: order.externalOrderId || order.confirmationId || null,
    });
  }
  return { packageId: pkg.id, duplicate: false };
}

function upsertUnmatchedOrder(order) {
  const existing = db.prepare(`
    SELECT id FROM unmatched_orders
    WHERE is_resolved = 0
      AND (
        (external_order_id IS NOT NULL AND external_order_id != '' AND external_order_id = ?)
        OR (confirmation_id IS NOT NULL AND confirmation_id != '' AND confirmation_id = ?)
      )
  `).get(order.externalOrderId || "", order.confirmationId || "");
  const stamp = nowIso();
  if (existing) {
    db.prepare(`
      UPDATE unmatched_orders
      SET external_restaurant_id = ?, restaurant_name_from_payload = ?, platform = ?, platform_slug = ?, provider_name = ?,
          customer_name = ?, customer_phone = ?, total_price = ?, status = ?, raw_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(
      order.externalRestaurantId || null,
      order.restaurantNameFromPayload || null,
      order.platform || null,
      order.platformSlug || null,
      order.providerName || null,
      order.customerName || null,
      order.customerPhone || order.contactPhone || null,
      order.discountedPrice || order.totalPrice || 0,
      order.statusText || order.rawStatus || null,
      json(order.rawPayload || {}),
      stamp,
      existing.id
    );
    return existing.id;
  }
  const id = uid("unm");
  db.prepare(`
    INSERT INTO unmatched_orders (
      id, external_order_id, confirmation_id, external_restaurant_id, restaurant_name_from_payload, platform,
      platform_slug, provider_name, customer_name, customer_phone, total_price, status, raw_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    order.externalOrderId || null,
    order.confirmationId || null,
    order.externalRestaurantId || null,
    order.restaurantNameFromPayload || null,
    order.platform || null,
    order.platformSlug || null,
    order.providerName || null,
    order.customerName || null,
    order.customerPhone || order.contactPhone || null,
    order.discountedPrice || order.totalPrice || 0,
    order.statusText || order.rawStatus || null,
    json(order.rawPayload || {}),
    stamp,
    stamp
  );
  return id;
}

function canonicalPlatformOrderToUnmatched(order = {}, rawPayload = null) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : (order.rawPayload || {});
  const normalizedPayload = normalizeWebhookOrderPayload(payload);
  return {
    ...normalizedPayload,
    externalOrderId: trimmed(
      order.externalOrderId ||
      order.platformOrderId ||
      order.orderId ||
      order.posentegraId ||
      normalizedPayload.externalOrderId
    ),
    posentegraId: trimmed(order.posentegraId || normalizedPayload.posentegraId),
    confirmationId: trimmed(order.confirmationId || normalizedPayload.confirmationId),
    externalRestaurantId: trimmed(
      order.externalRestaurantId ||
      order.platformRestaurantId ||
      normalizedPayload.externalRestaurantId
    ),
    platform: trimmed(order.platform || normalizedPayload.platform) || "Diger",
    platformSlug: trimmed(order.platformKey || order.platformSlug || normalizedPayload.platformSlug),
    providerName: trimmed(order.providerName || normalizedPayload.providerName || order.platform),
    customerName: trimmed(order.customerName || normalizedPayload.customerName),
    customerPhone: trimmed(order.customerPhone || order.phone || normalizedPayload.customerPhone),
    totalPrice: normalizeMoney(order.totalAmount ?? order.totalPrice ?? normalizedPayload.totalPrice),
    rawPayload: payload,
  };
}

function persistUnmatchedIncomingOrder(order, req = null, options = {}) {
  const unmatchedId = upsertUnmatchedOrder(order);
  logPlatformRestaurantNotMatched(order, req);
  if (options.logApiAttempt !== false) {
    logApiWebhookAttempt({
      req,
      order,
      isMatched: false,
      httpStatus: Number(options.httpStatus || 202),
      status: "unmatched",
    });
  }
  broadcastLiveEvent({
    type: "order:unmatched",
    message: `Eslestirilemeyen platform siparisi alindi: ${order.externalRestaurantId || "-"}`,
  });
  logger.warn("unmatched_order_persisted", {
    request_id: req?.requestId || null,
    unmatched_order_id: unmatchedId,
    platform: platformApiKey(order.platform || order.platformSlug || order.providerName),
    platform_restaurant_id: order.externalRestaurantId || null,
    platform_order_id: order.externalOrderId || order.confirmationId || null,
    pid: order.posentegraId || null,
  });
  return unmatchedId;
}

function resolveUnmatchedOrderForMatchedPackage(order, restaurantId, packageId) {
  db.prepare(`
    UPDATE unmatched_orders
    SET is_resolved = 1, resolved_restaurant_id = ?, resolved_package_id = ?, resolved_at = ?, updated_at = ?
    WHERE is_resolved = 0
      AND (
        (external_order_id IS NOT NULL AND external_order_id != '' AND external_order_id = ?)
        OR (confirmation_id IS NOT NULL AND confirmation_id != '' AND confirmation_id = ?)
      )
  `).run(
    restaurantId,
    packageId,
    nowIso(),
    nowIso(),
    order.externalOrderId || "",
    order.confirmationId || ""
  );
}

function getUnmatchedOrders(limit = 100) {
  return db.prepare("SELECT * FROM unmatched_orders ORDER BY is_resolved ASC, datetime(created_at) DESC LIMIT ?").all(clampLimit(limit)).map((row) => ({
    id: row.id,
    externalOrderId: row.external_order_id,
    confirmationId: row.confirmation_id,
    externalRestaurantId: row.external_restaurant_id,
    restaurantNameFromPayload: row.restaurant_name_from_payload,
    platform: row.platform,
    platformSlug: row.platform_slug,
    providerName: row.provider_name,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    totalPrice: Number(row.total_price || 0),
    status: row.status,
    rawPayload: parseJson(row.raw_payload, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isResolved: Boolean(row.is_resolved),
    resolvedRestaurantId: row.resolved_restaurant_id,
    resolvedPackageId: row.resolved_package_id,
    resolvedAt: row.resolved_at,
  }));
}

function updateRestaurantPlatformIds(restaurantId, body = {}) {
  const current = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(restaurantId);
  if (!current) {
    throw httpError(404, "Restoran bulunamadi.");
  }
  const platformIds = normalizeRestaurantPlatformIds({
    trendyolRestaurantId: body.trendyolRestaurantId ?? body.trendyol_restaurant_id ?? current.trendyol_restaurant_id,
    yemeksepetiRestaurantId: body.yemeksepetiRestaurantId ?? body.yemeksepeti_restaurant_id ?? current.yemeksepeti_restaurant_id,
    getirRestaurantId: body.getirRestaurantId ?? body.getir_restaurant_id ?? current.getir_restaurant_id,
    migrosRestaurantId: body.migrosRestaurantId ?? body.migros_restaurant_id ?? current.migros_restaurant_id,
    posentegraId: body.posentegraId ?? body.posentegra_id ?? current.posentegra_id,
    externalRestaurantIds: body.externalRestaurantIds ?? body.external_restaurant_ids ?? current.external_restaurant_ids,
  });
  assertUniqueRestaurantPlatformIds(platformIds, restaurantId);
  db.prepare(`
    UPDATE restaurants
    SET trendyol_restaurant_id = ?, yemeksepeti_restaurant_id = ?, getir_restaurant_id = ?,
        migros_restaurant_id = ?, posentegra_id = ?, external_restaurant_ids = ?
    WHERE id = ?
  `).run(
    platformIds.trendyolRestaurantId || null,
    platformIds.yemeksepetiRestaurantId || null,
    platformIds.getirRestaurantId || null,
    platformIds.migrosRestaurantId || null,
    platformIds.posentegraId || null,
    json(platformIds.externalRestaurantIds || []),
    restaurantId
  );
  return getRestaurants({ restaurantId })[0];
}

function updateRestaurantLocation(restaurantId, body = {}) {
  const current = db.prepare("SELECT id, x, y FROM restaurants WHERE id = ?").get(restaurantId);
  if (!current) {
    throw httpError(404, "Restoran bulunamadi.");
  }
  const { latitude, longitude } = parseLatitudeLongitude(body);
  if (!coordinatesAreValid(latitude, longitude)) {
    throw validationError("Restoran koordinatlari gecersiz.");
  }
  db.prepare("UPDATE restaurants SET x = ?, y = ? WHERE id = ?").run(latitude, longitude, restaurantId);
  return {
    restaurant: getRestaurants({ restaurantId })[0],
    previousLocation: {
      latitude: Number(current.x),
      longitude: Number(current.y),
    },
  };
}

function updateRestaurantCredentials(restaurantId, body = {}) {
  const current = db.prepare("SELECT id, username FROM restaurants WHERE id = ?").get(restaurantId);
  if (!current) {
    throw httpError(404, "Restoran bulunamadi.");
  }

  const username = trimmed(body.username ?? body.portalUsername).toLowerCase();
  const password = String(body.password ?? body.portalPassword ?? "");
  if (username.length < 3) {
    throw validationError("Restoran kullanici adi en az 3 karakter olmali.");
  }
  if (password && password.length < 8) {
    throw validationError("Restoran sifresi en az 8 karakter olmali.");
  }

  const duplicate = db.prepare("SELECT id FROM restaurants WHERE username = ? AND id <> ?").get(username, restaurantId);
  if (duplicate) {
    throw httpError(409, "Bu restoran kullanici adi zaten kullaniliyor.");
  }

  db.prepare("UPDATE restaurants SET username = ? WHERE id = ?").run(username, restaurantId);
  if (password) {
    updateActorPassword("restaurant", restaurantId, password);
  }

  return {
    restaurant: getRestaurants({ restaurantId })[0],
    previousUsername: current.username,
    passwordChanged: Boolean(password),
  };
}

function saveExternalIdToRestaurant(restaurantId, platform, externalRestaurantId, options = {}) {
  const incoming = trimmed(externalRestaurantId);
  if (!incoming) return null;
  const lowerPlatform = trimmed(platform).toLowerCase();
  const field = lowerPlatform.includes("trendyol")
    ? "trendyolRestaurantId"
    : lowerPlatform.includes("yemek") || lowerPlatform === "ys"
      ? "yemeksepetiRestaurantId"
      : lowerPlatform.includes("getir")
        ? "getirRestaurantId"
        : lowerPlatform.includes("migros")
          ? "migrosRestaurantId"
          : "";
  const restaurant = getRestaurants({ restaurantId })[0];
  if (!restaurant) return null;
  const knownIds = [
    restaurant.posentegraId,
    restaurant.trendyolRestaurantId,
    restaurant.yemeksepetiRestaurantId,
    restaurant.getirRestaurantId,
    restaurant.migrosRestaurantId,
    ...restaurant.externalRestaurantIds.map((item) => item.restaurantId),
  ].filter(Boolean);
  if (knownIds.includes(incoming)) {
    return restaurant;
  }
  if (options.sharedAcrossPlatforms) {
    return updateRestaurantPlatformIds(restaurantId, {
      externalRestaurantIds: [
        ...restaurant.externalRestaurantIds,
        { platform: "posentegra", restaurantId: incoming },
      ],
    });
  }
  if (field && !restaurant[field]) {
    return updateRestaurantPlatformIds(restaurantId, { [field]: incoming });
  }
  if (!restaurant.externalRestaurantIds.some((item) => item.restaurantId === incoming)) {
    return updateRestaurantPlatformIds(restaurantId, {
      externalRestaurantIds: [...restaurant.externalRestaurantIds, { platform, restaurantId: incoming }],
    });
  }
  return restaurant;
}

function matchUnmatchedOrder(unmatchedOrderId, restaurantId, options = {}) {
  const row = db.prepare("SELECT * FROM unmatched_orders WHERE id = ?").get(unmatchedOrderId);
  if (!row) {
    throw httpError(404, "Eslestirilemeyen siparis bulunamadi.");
  }
  if (row.is_resolved) {
    throw validationError("Bu siparis zaten eslestirilmis.");
  }
  const restaurant = getRestaurants({ restaurantId })[0];
  if (!restaurant) {
    throw httpError(404, "Restoran bulunamadi.");
  }
  const order = normalizeWebhookOrderPayload(parseJson(row.raw_payload, {}));
  const result = upsertWebhookPackage(order, restaurant);
  db.prepare(`
    UPDATE unmatched_orders
    SET is_resolved = 1, resolved_restaurant_id = ?, resolved_package_id = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `).run(restaurantId, result.packageId, nowIso(), nowIso(), unmatchedOrderId);
  if (options.saveExternalId !== false) {
    saveExternalIdToRestaurant(restaurantId, order.platform, order.externalRestaurantId, {
      sharedAcrossPlatforms: isPosentegraWebhookPayload(order.rawPayload),
    });
  }
  return {
    packageId: result.packageId,
    duplicate: result.duplicate,
    restaurant: getRestaurants({ restaurantId })[0],
  };
}

function sampleWebhookPayload() {
  return {
    pid: `TEST-${Date.now()}`,
    restaurantId: "6377deac15d5d59aee02bf51",
    restaurantName: "Cizbiz Sucuk",
    confirmationId: `CONF-${Date.now()}`,
    provider: { slug: "ys", kaynak: "Yemek Sepeti", id: "60cdef4f451ac719569864f4", alici: "yswh" },
    client: {
      name: "Orhan Genckiren",
      location: { lat: "41.1185938", lon: "29.0022812", text: "41.1185938 29.0022812" },
      clientPhoneNumber: "5421803474",
      contactPhoneNumber: "5421803474",
      deliveryAddress: {
        address: "190. Sk.",
        aptNo: "8-C",
        floor: "Giris",
        doorNo: "0",
        city: "Istanbul",
        district: "Ayazaga Sariyer",
        street: "190. Sk.",
        description: "0",
      },
    },
    status: 900,
    totalPrice: 400,
    totalDiscountedPrice: 340,
    totalDiscount: 60,
    clientNote: "CATAL BICAK GONDERMEYIN Nakit",
    deliveryType: 2,
    paymentMethod: "1",
    paymentMethodText: { tr: "Nakit", en: "Nakit" },
    posPaymentMethod: "Nakit",
    pos_ticket: 228664,
    products: [{
      id: "3294488",
      count: "1",
      product: "fb470646-2ee9-4109-bd05-8bbc96cc96ff",
      note: "tursu olmasin icinde lutfen",
      name: { tr: "Tam Ekmek Arasi Karisik Izgara", en: "Tam Ekmek Arasi Karisik Izgara" },
      price: "400",
      optionPrice: 0,
      priceWithOption: 400,
      totalPrice: 400,
    }],
    restaurant: { id: "6377deac15d5d59aee02bf51", name: "Cizbiz Sucuk" },
    shortCode: "5586",
  };
}

function logApiWebhookAttempt({ req, order, restaurantId = null, isMatched = false, httpStatus = 200, status = "success", errorMessage = "" }) {
  if (!WEBHOOK_LOG_ENABLED) return 0;
  return logWebhookAttempt({
    restaurantId,
    sourcePlatform: order?.platform,
    externalOrderNo: order?.externalOrderId,
    signatureValid: httpStatus !== 401,
    responseStatus: httpStatus,
    requestBody: json(order?.rawPayload || {}),
    requestId: req.requestId,
    provider: order?.providerName,
    platform: order?.platform,
    externalRestaurantId: order?.externalRestaurantId,
    externalOrderId: order?.externalOrderId,
    isMatched,
    status,
    httpStatus,
    errorMessage,
    rawPayload: order?.rawPayload,
    headers: req.headers,
    ipAddress: clientIp(req),
  });
}

function logPlatformEvent(entry = {}) {
  try {
    db.prepare(`
      INSERT INTO platform_events (
        platform, restaurant_id, platform_account_id, event_type, request_id, status, http_status,
        error_code, error_message, retry_count, next_retry_at, dead_lettered_at, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.platform || null,
      entry.restaurantId || null,
      entry.platformAccountId || null,
      entry.eventType || "webhook",
      entry.requestId || null,
      entry.status || "error",
      entry.httpStatus || null,
      entry.errorCode || null,
      entry.errorMessage || null,
      Number(entry.retryCount || 0),
      entry.nextRetryAt || null,
      entry.deadLetteredAt || null,
      json(entry.metadata || {}),
      entry.createdAt || nowIso()
    );
  } catch (error) {
    logger.warn("Platform event log failed", { error: error.message, eventType: entry.eventType });
  }
}

function getPlatformEvents(limit = 20, filter = {}) {
  const offset = parsePositiveInteger(filter.offset, 0);
  const params = [];
  const where = [];
  if (filter.restaurantId) {
    where.push("restaurant_id = ?");
    params.push(filter.restaurantId);
  }
  if (filter.platformAccountId) {
    where.push("platform_account_id = ?");
    params.push(filter.platformAccountId);
  }
  const sql = `
    SELECT * FROM platform_events
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...params, limit, offset);
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    restaurantId: row.restaurant_id,
    platformAccountId: row.platform_account_id,
    eventType: row.event_type,
    requestId: row.request_id,
    status: row.status,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count || 0,
    nextRetryAt: row.next_retry_at,
    deadLetteredAt: row.dead_lettered_at,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  }));
}

function providerHealthUrlForAccount(account) {
  const slugKey = platformSlug(account?.platform).toUpperCase().replace(/-/g, "_");
  return trimmed(
    process.env[`DELIVERA_HEALTH_URL_${slugKey}`] ||
    process.env[`DELIVERA_VERIFY_URL_${slugKey}`] ||
    process.env[platformVerifyEnvKey(account?.platform)] ||
    ""
  );
}

async function checkPlatformAccountConnection(account, req = null) {
  const result = await connectionHealthService.checkAccount(account);
  if (!result.ok) {
    logPlatformEvent({
      platform: account.platform,
      restaurantId: account.restaurantId,
      platformAccountId: account.id,
      eventType: "connection_check",
      requestId: req?.requestId || null,
      status: "error",
      httpStatus: result.httpStatus || null,
      errorCode: result.errorCode || HEALTH_ERROR_CODES.UNKNOWN_ERROR,
      errorMessage: result.errorMessage || "Platform connection check failed",
      metadata: {
        latencyMs: result.latencyMs,
        providerUrlConfigured: Boolean(result.providerUrlConfigured),
      },
    });
  }
  return {
    ok: Boolean(result.ok),
    result,
    account: sanitizePlatformAccount(getPlatformAccounts().find((item) => item.id === account.id) || account, true),
    recentEvents: getPlatformEvents(10, { platformAccountId: account.id }),
  };
}

function logPlatformConnectionTest(account, result) {
  const status = result?.status === "timeout" ? 408 : Number(result?.status || 0) || 500;
  logWebhookAttempt({
    restaurantId: account?.restaurantId,
    sourcePlatform: account?.platform,
    externalOrderNo: "connection-test",
    signatureValid: Boolean(result?.ok),
    responseStatus: status,
    requestBody: json({
      type: "platform_connection_test",
      platform: account?.platform,
      externalStoreId: account?.externalStoreId,
      status: result?.status || null,
      ok: Boolean(result?.ok),
      message: result?.message || "",
    }),
  });
}

function platformConnectionHttpStatus(result) {
  if (result?.ok) return 200;
  if (result?.optional || result?.manualAvailable || result?.status === 200) return 200;
  if (result?.status === 401) return 401;
  if (result?.status === 403) return 403;
  if (result?.status === 404) return 404;
  if (result?.status === "timeout") return 408;
  return 400;
}

function optionalIntegrationResult(message = "Polling kapali veya API bilgileri eksik.") {
  return {
    ok: false,
    optional: true,
    manualAvailable: true,
    status: 200,
    message,
  };
}

function platformAccountMissingCredentials(account) {
  const platform = normalizePlatformInput(account?.platform);
  if (platform === "Trendyol Yemek") {
    return !(account?.apiKey && account?.apiSecret && (account?.externalMerchantId || account?.externalStoreId || account?.externalId));
  }
  if (platform === "POS") {
    return !((account?.token || account?.accessToken) && (account?.apiSecret || account?.webhookSecret));
  }
  return !(account?.apiKey || account?.apiSecret || account?.token || account?.accessToken || account?.apiUsername || account?.apiPassword);
}

function isCreatedPlatformOrder(rawOrder) {
  const order = rawOrder?.order || rawOrder || {};
  const status = trimmed(
    order.status ??
    order.orderStatus ??
    order.order_status ??
    order.packageStatus ??
    order.package_status ??
    rawOrder?.status
  ).toLowerCase();
  return status === "created";
}

function isPollableCreatedPlatformOrder(platform, rawOrder) {
  const normalizedPlatform = normalizePlatformInput(platform);
  if (normalizedPlatform !== "POS") {
    return isCreatedPlatformOrder(rawOrder);
  }

  const order = rawOrder?.order || rawOrder || {};
  const status = trimmed(
    order.status ??
    order.orderStatus ??
    order.order_status ??
    order.packageStatus ??
    order.package_status ??
    rawOrder?.status
  ).toLowerCase();

  return !status || ["created", "new", "pending", "open"].includes(status);
}

function buildIntegrationInfo(req, restaurant) {
  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey ? "Kayitli" : "",
    webhookSecret: restaurant.webhookSecret ? "Kayitli" : "",
    endpoint: `${requestBaseUrl(req)}/api/platform/order`,
    platformWebhookBase: `${requestBaseUrl(req)}/api/platform/order`,
    signatureHeader: "x-platform-secret",
    samplePayload: {
      platform: platformSlug(restaurant.platforms[0] || "Trendyol Yemek").replace(/-/g, "_"),
      platformRestaurantId: restaurant.id,
      orderId: "PLATFORM-ORDER-ID",
      customerName: "Musteri Adi",
      phone: "5551234567",
      address: "Mersin teslimat adresi",
      totalPrice: 250,
    },
  };
}

function redactSecretsFromText(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  try {
    const data = JSON.parse(text);
    const redact = (item) => {
      if (Array.isArray(item)) {
        return item.map(redact);
      }
      if (item && typeof item === "object") {
        return Object.fromEntries(Object.entries(item).map(([key, val]) => {
          const lower = key.toLowerCase();
          if (lower.includes("secret") || lower.includes("token") || lower.includes("password") || lower.includes("apikey") || lower.includes("api_key")) {
            return [key, "***"];
          }
          return [key, redact(val)];
        }));
      }
      return item;
    };
    return JSON.stringify(redact(data));
  } catch {
    return text.replace(/("(?:api_?key|api_?secret|token|secret|password)"\s*:\s*")[^"]+(")/gi, "$1***$2");
  }
}

function platformVerifyEnvKey(platform) {
  return `DELIVERA_VERIFY_URL_${platformSlug(platform).toUpperCase().replace(/-/g, "_")}`;
}

async function verifyGenericPlatformCredentials(platform, draft) {
  const verifyUrl = trimmed(process.env[platformVerifyEnvKey(platform)]);
  if (!verifyUrl) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "deferred_webhook",
      note: `${platform} icin canli partner verify URL tanimli degil. Ilk basarili webhook veya ozel verify URL sonrasi dogrulama tamamlanir.`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        Authorization: draft.apiKey ? `Bearer ${draft.apiKey}` : "",
        "x-api-key": draft.apiKey || "",
        "x-api-secret": draft.apiSecret || "",
        "x-external-store-id": draft.externalStoreId || "",
        "x-external-merchant-id": draft.externalMerchantId || "",
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.VERIFIED,
        mode: "remote_partner_api",
        note: `${platform} merchant credentials uzaktan dogrulandi.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.FAILED,
        mode: "remote_partner_api",
        note: `${platform} merchant credentials reddedildi (${response.status}).`,
      };
    }

    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "remote_partner_api",
      note: `${platform} partner verify istegi ${response.status} dondu. Manuel kontrol gerekebilir.`,
    };
  } catch (error) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "remote_partner_api",
      note: `${platform} verify istegi tamamlanamadi: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTrendyolMerchantCredentials(draft) {
  if (!draft.apiKey || !draft.apiSecret || !draft.externalStoreId) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.FAILED,
      mode: "remote_partner_api",
      note: "Trendyol merchant dogrulamasi icin seller/store id, api key ve api secret zorunludur.",
    };
  }

  const isStage = ["1", "true", "yes"].includes(String(process.env.TRENDYOL_STAGE_MODE || "").toLowerCase());
  const sellerId = draft.externalStoreId;
  const targetUrl = `${isStage ? "https://stageapigw.trendyol.com" : "https://apigw.trendyol.com"}/integration/webhook/sellers/${encodeURIComponent(sellerId)}/webhooks`;
  const authValue = Buffer.from(`${draft.apiKey}:${draft.apiSecret}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${authValue}`,
        "User-Agent": `${sellerId} - RESTOMAP`,
        ...(draft.storeFrontCode ? { storeFrontCode: draft.storeFrontCode } : {}),
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.VERIFIED,
        mode: "trendyol_webhook_api",
        note: "Trendyol merchant credentials resmi webhook servisi ile dogrulandi.",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.FAILED,
        mode: "trendyol_webhook_api",
        note: `Trendyol merchant credentials reddedildi (${response.status}).`,
      };
    }

    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "trendyol_webhook_api",
      note: `Trendyol verify cevabi ${response.status}. StoreFrontCode veya panel yetkisi kontrol edilmeli.`,
    };
  } catch (error) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "trendyol_webhook_api",
      note: `Trendyol verify istegi tamamlanamadi: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyPlatformMerchantCredentials(draft) {
  if (draft.platform === "Trendyol Yemek") {
    return verifyTrendyolMerchantCredentials(draft);
  }

  return verifyGenericPlatformCredentials(draft.platform, draft);
}

function markPlatformAccountVerification(accountId, verification) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE platform_accounts
    SET verification_status = ?, verification_note = ?, last_verification_at = ?, verified_at = ?, last_validation_mode = ?, updated_at = ?
    WHERE id = ?
  `).run(
    verification.status,
    verification.note,
    now,
    verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
    verification.mode || null,
    now,
    accountId
  );
}

function markPlatformAccountVerifiedFromWebhook(accountId, platform) {
  markPlatformAccountVerification(accountId, {
    status: PLATFORM_VERIFICATION_STATUS.VERIFIED,
    mode: "live_webhook",
    note: `${platform} hesabindan basarili canli webhook alindi.`,
  });
}

function createRestaurantRecord(body, trace = {}) {
  const restaurant = {
    id: uid("rst"),
    ...validateRestaurantDraft(body),
    username: trimmed(body.portalUsername || body.username).toLowerCase() || createPortalUsername(body.name),
    apiKey: createApiKey(),
    webhookSecret: createWebhookSecret(),
  };
  const restaurantPassword = restaurant.portalPassword || String(body.portalPassword || body.password || `Rest${Math.floor(1000 + Math.random() * 9000)}!`);
  const restaurantPasswordInfo = hashPassword(restaurantPassword);

  if (db.prepare("SELECT id FROM restaurants WHERE username = ?").get(restaurant.username)) {
    logger.warn("INSERT_SKIPPED", {
      requestId: trace.requestId || null,
      tableName: "restaurants",
      reason: "username_already_exists",
      username: restaurant.username,
    });
    throw validationError("Bu restoran kullanici adi zaten kullaniliyor.");
  }
  assertUniqueRestaurantPlatformIds(restaurant);

  const insertSql = `
    INSERT INTO restaurants (
      id, name, zone, x, y, username, password_hash, password_salt, platforms_json, api_key, webhook_secret,
      trendyol_restaurant_id, yemeksepeti_restaurant_id, getir_restaurant_id, migros_restaurant_id, posentegra_id, external_restaurant_ids,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const insertParams = [
    restaurant.id,
    restaurant.name,
    restaurant.zone,
    restaurant.latitude,
    restaurant.longitude,
    restaurant.username,
    restaurantPasswordInfo.hash,
    restaurantPasswordInfo.salt,
    json(restaurant.platforms),
    restaurant.apiKey,
    restaurant.webhookSecret,
    restaurant.trendyolRestaurantId || null,
    restaurant.yemeksepetiRestaurantId || null,
    restaurant.getirRestaurantId || null,
    restaurant.migrosRestaurantId || null,
    restaurant.posentegraId || null,
    json(restaurant.externalRestaurantIds || []),
    new Date().toISOString(),
  ];
  runInsertWithTrace({
    sql: insertSql,
    params: insertParams,
    tableName: "restaurants",
    insertedId: restaurant.id,
    requestId: trace.requestId || null,
  });

  return {
    restaurant,
    restaurantPassword,
  };
}

function createPackageRecord(pkg, packageType = "Platform Siparisi", trace = {}) {
  const packagePosentegraId = resolvePackagePosentegraId(pkg);
  if (!packagePosentegraId) {
    logger.error("order_pid_missing_for_package_create", {
      request_id: trace.requestId || null,
      package_id: pkg.id || null,
      internal_restaurant_id: pkg.restaurantId || null,
      platform_order_id: pkg.externalOrderId || pkg.externalOrderNo || null,
      source: pkg.source || null,
    });
    throw validationError("Paket icin posentegra_id/order pid bulunamadi.");
  }
  const insertSql = `
    INSERT INTO packages (
      id, tracking_no, restaurant_id, source, delivery_address, package_type, source_platform, platform_restaurant_id, posentegra_id, external_order_no, external_order_id,
      recipient, phone, address, zone, eta, payment_method, order_amount, payment_status, payment_collected_by, collected_amount, courier_collection_note, restaurant_customer_id,
      x, y, customer_lat, customer_lng, customer_address, note, customer_note, items_json, raw_payload_json, status, assignment_status,
      assigned_courier_id, assigned_courier_name, assigned_at, accepted_at, on_route_at, delivered_at, failed_at,
      distance_km, assignment_reason, failure_reason, last_assignment_attempt_at, last_assignment_error, assignment_tried_courier_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const insertParams = [
    pkg.id,
    ensureUniqueTrackingNo(pkg.trackingNo),
    pkg.restaurantId,
    pkg.source,
    pkg.deliveryAddress || pkg.address,
    packageType,
    pkg.sourcePlatform,
    pkg.platformRestaurantId || pkg.externalRestaurantId || null,
    packagePosentegraId,
    pkg.externalOrderNo,
    pkg.externalOrderId || pkg.externalOrderNo,
    pkg.recipient,
    pkg.phone,
    pkg.address,
    pkg.zone,
    pkg.eta,
    pkg.paymentMethod,
    normalizeMoney(pkg.orderAmount),
    pkg.paymentStatus,
    pkg.paymentCollectedBy || normalizeCollectedBy(pkg.paymentStatus),
    normalizeMoney(pkg.collectedAmount),
    pkg.courierCollectionNote || null,
    pkg.restaurantCustomerId || null,
    pkg.latitude,
    pkg.longitude,
    pkg.customerLatitude ?? null,
    pkg.customerLongitude ?? null,
    pkg.customerAddress || pkg.deliveryAddress || pkg.address,
    pkg.note,
    pkg.customerNote || null,
    json(Array.isArray(pkg.items) ? pkg.items : []),
    json(pkg.rawPayload || null),
    pkg.status,
    pkg.assignmentStatus || assignmentStatusForOrder(pkg.status),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    pkg.assignmentReason,
    pkg.failureReason || null,
    pkg.lastAssignmentAttemptAt || null,
    pkg.lastAssignmentError || null,
    json(normalizeIdList(pkg.assignmentTriedCourierIds || [])),
    pkg.createdAt,
    pkg.updatedAt || pkg.createdAt,
  ];
  runInsertWithTrace({
    sql: insertSql,
    params: insertParams,
    tableName: "packages",
    insertedId: pkg.id,
    requestId: trace.requestId || null,
  });
  if (pkg.restaurantCustomerId) {
    db.prepare("UPDATE packages SET customer_id = ? WHERE id = ?").run(pkg.restaurantCustomerId, pkg.id);
  }
  const verified = db.prepare("SELECT id, restaurant_id, platform_restaurant_id, posentegra_id, external_order_id FROM packages WHERE id = ?").get(pkg.id);
  if (!verified?.posentegra_id) {
    logger.error("package_posentegra_id_db_verify_failed", {
      request_id: trace.requestId || null,
      package_id: pkg.id,
      internal_restaurant_id: pkg.restaurantId,
      platform_order_id: pkg.externalOrderId || pkg.externalOrderNo || null,
    });
    throw new Error("packages.posentegra_id DB dogrulamasi basarisiz.");
  }
  logger.info("order_pid_linked", {
    request_id: trace.requestId || null,
    package_id: pkg.id,
    internal_restaurant_id: verified.restaurant_id,
    pid: verified.posentegra_id,
    posentegra_id: verified.posentegra_id,
    platform_restaurant_id: verified.platform_restaurant_id || null,
    platform_order_id: verified.external_order_id || pkg.externalOrderNo || null,
  });
  enqueuePosentegraPackageAssignment(pkg);
}

function findDuplicatePackage(restaurantId, source, externalOrderId, posentegraId = "") {
  if (!restaurantId || (!externalOrderId && !posentegraId)) {
    return null;
  }

  if (posentegraId) {
    const existingByPosentegraId = db.prepare(`
      SELECT * FROM packages
      WHERE restaurant_id = ? AND posentegra_id = ?
    `).get(restaurantId, posentegraId);
    if (existingByPosentegraId) {
      return existingByPosentegraId;
    }
  }

  if (!externalOrderId) {
    return null;
  }

  if (!source || source === "platform_any") {
    return db.prepare(`
      SELECT * FROM packages
      WHERE restaurant_id = ? AND source IN ('platform_webhook', 'platform_polling') AND external_order_id = ?
    `).get(restaurantId, externalOrderId) || null;
  }

  return db.prepare(`
    SELECT * FROM packages
    WHERE restaurant_id = ? AND source = ? AND external_order_id = ?
  `).get(restaurantId, source, externalOrderId) || null;
}

function lifecycleColumnsForStatus(status, current = {}) {
  const normalized = normalizeStatus(status);
  const stamp = nowIso();
  return {
    assignmentStatus: assignmentStatusForOrder(normalized),
    assignedAt: normalized === ASSIGNED_STATUS ? (current.assignedAt || stamp) : current.assignedAt || null,
    acceptedAt: normalized === ACCEPTED_BY_COURIER_STATUS ? (current.acceptedAt || stamp) : current.acceptedAt || null,
    onRouteAt: normalized === ON_ROUTE_STATUS ? (current.onRouteAt || stamp) : current.onRouteAt || null,
    deliveredAt: normalized === DELIVERED_STATUS ? (current.deliveredAt || stamp) : current.deliveredAt || null,
    failedAt: normalized === FAILED_STATUS ? (current.failedAt || stamp) : current.failedAt || null,
  };
}

function updatePackageLifecycle(packageId, updates, current = {}, options = {}) {
  const status = normalizeStatus(updates.status || current.status);
  const lifecycle = lifecycleColumnsForStatus(status, current);
  const assignedCourierId = updates.assignedCourierId ?? current.assignedCourierId ?? null;
  if ([ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(status) && !trimmed(assignedCourierId)) {
    throw validationError('Kurye atanmadan paket atanmis, kabul edildi veya yolda durumuna gecemez.');
  }
  const storedPaymentMethod = db.prepare("SELECT payment_method FROM packages WHERE id = ?").get(packageId)?.payment_method;
  const paymentMethod = trimmed(updates.paymentMethod ?? updates.payment_method ?? current.paymentMethod ?? current.payment_method ?? storedPaymentMethod);
  const paymentStatus = normalizePaymentStatus(updates.paymentStatus || current.paymentStatus, paymentMethod);
  const collectedAmount = updates.collectedAmount !== undefined
    ? normalizeMoney(updates.collectedAmount)
    : ([CASH_COLLECTED_PAYMENT_STATUS, CREDIT_CARD_COLLECTED_PAYMENT_STATUS, PAID_ONLINE_PAYMENT_STATUS, RESTAURANT_COLLECTED_PAYMENT_STATUS, COLLECTED_PAYMENT_STATUS].includes(paymentStatus)
      ? normalizeMoney(current.orderAmount)
      : normalizeMoney(current.collectedAmount || 0));
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, payment_method = ?, payment_status = ?, failure_reason = ?, assigned_courier_id = ?, assigned_courier_name = ?,
        assigned_at = ?, accepted_at = ?, on_route_at = ?, delivered_at = ?, failed_at = ?, last_assignment_attempt_at = ?,
        last_assignment_error = ?, payment_collected_by = ?, collected_amount = ?, courier_collection_note = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    updates.assignmentStatus || lifecycle.assignmentStatus,
    paymentMethod,
    paymentStatus,
    updates.failureReason ?? current.failureReason ?? null,
    assignedCourierId,
    updates.assignedCourierName ?? current.assignedCourierName ?? null,
    updates.assignedAt ?? lifecycle.assignedAt,
    updates.acceptedAt ?? lifecycle.acceptedAt,
    updates.onRouteAt ?? lifecycle.onRouteAt,
    updates.deliveredAt ?? lifecycle.deliveredAt,
    updates.failedAt ?? lifecycle.failedAt,
    updates.lastAssignmentAttemptAt ?? current.lastAssignmentAttemptAt ?? null,
    updates.lastAssignmentError ?? current.lastAssignmentError ?? null,
    updates.paymentCollectedBy ?? normalizeCollectedBy(paymentStatus, current.paymentCollectedBy),
    collectedAmount,
    updates.courierCollectionNote ?? current.courierCollectionNote ?? null,
    nowIso(),
    packageId
  );
  if (normalizeStatus(current.status) !== status && !options.skipPosentegraStatusSync) {
    const updatedPackage = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    enqueuePosentegraStatusChange(updatedPackage, status);
  }
  syncAssignmentRetryForPackage(getPackageById(packageId));
}

function extractPlatformIdentifiers(body) {
  const shipment = body?.content?.[0] || body;
  const client = shipment?.client || {};
  const store = shipment?.store || {};
  return [
    trimmed(body.restaurantId),
    trimmed(body.storeId),
    trimmed(body.vendorId),
    trimmed(body.chainId),
    trimmed(body.sellerId),
    trimmed(body.supplierId),
    trimmed(shipment?.storeId),
    trimmed(shipment?.sellerId),
    trimmed(shipment?.supplierId),
    trimmed(shipment?.vendorId),
    trimmed(shipment?.merchantId),
    trimmed(client.id),
    trimmed(client.vendor_id),
    trimmed(client.vendorId),
    trimmed(client.chain_id),
    trimmed(client.chainId),
    trimmed(store.id),
  ].filter(Boolean);
}

function verifyPlatformWebhookAuth(account, req, rawBody = undefined) {
  const signature = verifyPlatformSignature({ req, account, rawBody });
  if (signature.ok) {
    return true;
  }

  if (account.webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.BASIC_AUTH) {
    const basic = parseBasicAuthHeader(req);
    if (!basic || !basic.username || !basic.password) {
      return false;
    }
    // Use timing-safe comparison for credentials
    try {
      const usernameSafe = crypto.timingSafeEqual(
        Buffer.from(basic.username),
        Buffer.from(account.webhookUsername || "")
      );
      const passwordSafe = crypto.timingSafeEqual(
        Buffer.from(basic.password),
        Buffer.from(account.webhookPassword || "")
      );
      return usernameSafe && passwordSafe;
    } catch {
      return false;
    }
  }

  if (account.webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN) {
    const authorization = String(req.headers.authorization || "");
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const tokens = candidateHeaderValues(req, ["x-webhook-token", "x-static-token", "x-partner-token", "x-yemeksepeti-token"]);
    
    // Use timing-safe comparison for tokens
    const allTokens = [bearerToken, ...tokens].filter(Boolean);
    const expectedToken = account.staticToken || "";
    
    return allTokens.some((token) => {
      try {
        if (token.length !== expectedToken.length) return false;
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
      } catch {
        return false;
      }
    });
  }

  const apiKeys = candidateHeaderValues(req, ["x-api-key", "api-key", "x-platform-api-key"]);
  const expectedApiKey = account.webhookApiKey || "";
  
  // Use timing-safe comparison for API keys
  return apiKeys.some((key) => {
    try {
      if (key.length !== expectedApiKey.length) return false;
      return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expectedApiKey));
    } catch {
      return false;
    }
  });
}

function verifySimplePlatformSecret(account, restaurant, req) {
  const incomingSecret = candidateHeaderValues(req, ["x-platform-secret", "x-webhook-secret", "x-api-key"])[0] || "";
  if (!incomingSecret) {
    return false;
  }
  const allowedSecrets = [
    account?.webhookSecret,
    account?.staticToken,
    restaurant?.webhookSecret,
  ].map(trimmed).filter(Boolean);
  return allowedSecrets.includes(incomingSecret);
}

function mapExternalStatusToInternal(status) {
  const incoming = trimmed(status).toUpperCase();

  if (!incoming) {
    return PENDING_APPROVAL_STATUS;
  }

  if (["CREATED", "RECEIVED", "NEW", "PREPARING"].includes(incoming)) {
    return PENDING_APPROVAL_STATUS;
  }

  if (["ASSIGNED", "COURIER_ASSIGNED"].includes(incoming)) {
    return ASSIGNED_STATUS;
  }

  if (["ACCEPTED", "ACCEPTED_BY_COURIER"].includes(incoming)) {
    return ACCEPTED_BY_COURIER_STATUS;
  }

  if (["PICKED_UP", "ON_WAY", "ON_ROUTE", "IN_DELIVERY", "OUT_FOR_DELIVERY"].includes(incoming)) {
    return ON_ROUTE_STATUS;
  }

  if (["DELIVERED", "COMPLETED"].includes(incoming)) {
    return DELIVERED_STATUS;
  }

  if (["FAILED", "UNDELIVERED", "RETURNED", "UNSUPPLIED"].includes(incoming)) {
    return FAILED_STATUS;
  }

  if (["REJECTED"].includes(incoming)) {
    return REJECTED_STATUS;
  }

  if (["CANCELLED", "CANCELED"].includes(incoming)) {
    return CANCELED_STATUS;
  }

  return PENDING_APPROVAL_STATUS;
}

function normalizeIncomingPlatformPayload(platform, body, account, restaurant) {
  const shipment = body?.content?.[0] || body;
  const shipmentAddress = shipment?.shipmentAddress || shipment?.deliveryAddress || shipment?.address || {};
  const customer = shipment?.customer || {};
  const payment = shipment?.payment || {};
  const recipientName = joinAddress([
    shipmentAddress.firstName || customer.first_name || customer.name || shipment.recipient,
    shipmentAddress.lastName || customer.last_name || "",
  ]) || trimmed(customer.name) || trimmed(shipment.recipient) || "Musteri";
  const address = joinAddress([
    shipmentAddress.address1,
    shipmentAddress.address2,
    shipmentAddress.district || shipmentAddress.town || shipmentAddress.area,
    shipmentAddress.city,
    shipment.address,
  ]) || trimmed(shipment.address);
  const zone = pickFirstValue(
    shipment.zone,
    shipmentAddress.district,
    shipmentAddress.town,
    extractDistrict(address),
    restaurant.zone
  );
  const rawLatitude = Number(
    shipment.latitude ??
    shipment.lat ??
    shipment.geo_lat ??
    shipmentAddress.latitude ??
    shipmentAddress.lat ??
    restaurant.latitude
  );
  const rawLongitude = Number(
    shipment.longitude ??
    shipment.lng ??
    shipment.lon ??
    shipment.geo_lng ??
    shipmentAddress.longitude ??
    shipmentAddress.lng ??
    restaurant.longitude
  );
  const latitude = Number.isNaN(rawLatitude) ? Number(restaurant.latitude) : rawLatitude;
  const longitude = Number.isNaN(rawLongitude) ? Number(restaurant.longitude) : rawLongitude;
  const externalOrderNo = pickFirstValue(
    shipment.externalOrderNo,
    shipment.external_order_no,
    shipment.orderNumber,
    shipment.order_number,
    shipment.order_id,
    shipment.orderId,
    shipment.shipmentPackageId,
    shipment.packageId,
    shipment.order_code,
    `${platformSlug(platform)}-${Date.now()}`
  );
  const paymentMethod = pickFirstValue(
    shipment.paymentMethod,
    shipment.payment_method,
    payment.method,
    payment.payment_method,
    payment.type,
    "Online Odeme"
  );
  const orderAmount = normalizeMoney(
    shipment.orderAmount ??
    shipment.amount ??
    shipment.totalAmount ??
    shipment.total_amount ??
    shipment.totalPrice ??
    shipment.total_price ??
    payment.amount ??
    payment.total ??
    payment.totalAmount
  );
  const safeAddress = trimmed(address) || `${restaurant.name} teslimat adresi`;
  const safeZone = pickFirstValue(zone, restaurant.zone);
  const eta = pickFirstValue(
    shipment.eta,
    shipment.promised_for,
    shipment.accepted_for,
    `${suggestedRestaurantPrepMinutes(safeZone)} dk`
  );

  return {
    restaurantId: restaurant.id,
    source: "platform_webhook",
    sourcePlatform: platform,
    platformRestaurantId: pickFirstValue(
      shipment.platformRestaurantId,
      shipment.platform_restaurant_id,
      shipment.externalRestaurantId,
      shipment.external_restaurant_id,
      shipment.externalStoreId,
      shipment.external_store_id,
      body.platformRestaurantId,
      body.platform_restaurant_id,
      body.externalRestaurantId,
      body.external_restaurant_id
    ),
    externalRestaurantId: pickFirstValue(
      shipment.externalRestaurantId,
      shipment.external_restaurant_id,
      shipment.platformRestaurantId,
      shipment.platform_restaurant_id,
      shipment.externalStoreId,
      shipment.external_store_id,
      body.externalRestaurantId,
      body.external_restaurant_id,
      body.platformRestaurantId,
      body.platform_restaurant_id
    ),
    externalOrderNo,
    externalOrderId: externalOrderNo,
    posentegraId: resolvePackagePosentegraId({
      pid: body.pid ?? shipment.pid,
      posentegraId: body.posentegraId ?? body.posentegra_id ?? shipment.posentegraId ?? shipment.posentegra_id,
      externalOrderId: externalOrderNo,
    }),
    recipient: trimmed(recipientName) || "Musteri",
    phone: pickFirstValue(
      shipment.phone,
      shipment.phoneNumber,
      shipmentAddress.phone,
      customer.phone,
      customer.phone_number,
      "Gizli Numara"
    ),
    address: safeAddress,
    customerAddress: safeAddress,
    customerLatitude: latitude,
    customerLongitude: longitude,
    zone: safeZone,
    eta,
    paymentMethod,
    orderAmount,
    paymentStatus: normalizePaymentStatus("", paymentMethod),
    latitude,
    longitude,
    note: pickFirstValue(
      shipment.note,
      shipment.comment,
      shipment.customerNote,
      shipment.customer_note
    ),
    customerNote: pickFirstValue(shipment.customerNote, shipment.customer_note, shipment.note, shipment.comment),
    items: normalizeIncomingOrderItems(shipment.items || shipment.products || shipment.lines),
    rawPayload: body,
    status: mapExternalStatusToInternal(shipment.status),
  };
}

function upsertPlatformPackage(platform, restaurant, payload, options = {}) {
  return withImmediateTransaction(() => {
    const existing = findDuplicatePackage(
      restaurant.id,
      "platform_any",
      payload.externalOrderId || payload.externalOrderNo,
      payload.posentegraId
    );
    upsertPlatformOrderRecord({
      platform,
      platformRestaurantId: payload.platformRestaurantId || payload.externalRestaurantId,
      externalRestaurantId: payload.externalRestaurantId || payload.platformRestaurantId,
      posentegraId: payload.posentegraId,
      orderId: payload.externalOrderId || payload.externalOrderNo,
      customerName: payload.recipient,
      phone: payload.phone,
      address: payload.address,
      totalPrice: payload.orderAmount,
      note: payload.customerNote || payload.note,
      rawPayload: payload.rawPayload || payload,
    }, restaurant.id, payload.status === CANCELED_STATUS ? "cancelled" : "pending_approval", {
      requestId: options.requestId || null,
    });

    if (!existing) {
      const pkg = validateIntegrationDraft(payload, restaurant);
      createPackageRecord(pkg, "Platform Siparisi", { requestId: options.requestId || null });
      assertPersistedRecord("packages", pkg.id, "package_created", options.requestId || null);
      if (normalizeStatus(pkg.status) !== PENDING_APPROVAL_STATUS) {
        scheduleRebalancePackages();
      }
      writeAuditLog({
        actorRole: "integration",
        actorId: restaurant.id,
        action: "package_created_integration",
        packageId: pkg.id,
        restaurantId: restaurant.id,
        details: {
          sourcePlatform: pkg.sourcePlatform,
          externalOrderNo: pkg.externalOrderNo,
        },
      });
      return { ...getPackageById(pkg.id), duplicate: false };
    }

    logger.info("Duplicate order skipped", {
      platform,
      restaurantId: restaurant.id,
      externalOrderNo: payload.externalOrderNo,
      packageId: existing.id,
    });

    const currentStatus = normalizeStatus(existing.status);
    const incomingStatus = normalizeStatus(payload.status || currentStatus);
    const incomingPaymentStatus = normalizePaymentStatus(payload.paymentStatus, payload.paymentMethod);
    if (incomingStatus !== currentStatus && canTransitionStatus(currentStatus, incomingStatus)) {
      updatePackageLifecycle(existing.id, {
        status: incomingStatus,
        paymentStatus: incomingPaymentStatus,
        failureReason: payload.failureReason || existing.failure_reason || "",
      }, {
        status: existing.status,
        paymentStatus: existing.payment_status,
        failureReason: existing.failure_reason,
        assignedCourierId: existing.assigned_courier_id,
        assignedCourierName: existing.assigned_courier_name,
        assignedAt: existing.assigned_at,
        acceptedAt: existing.accepted_at,
        onRouteAt: existing.on_route_at,
        deliveredAt: existing.delivered_at,
        failedAt: existing.failed_at,
        lastAssignmentAttemptAt: existing.last_assignment_attempt_at,
        lastAssignmentError: existing.last_assignment_error,
        paymentMethod: existing.payment_method,
      });
      if (incomingStatus !== PENDING_APPROVAL_STATUS && incomingStatus !== REJECTED_STATUS) {
        scheduleRebalancePackages();
      }
      writeAuditLog({
        actorRole: "integration",
        actorId: restaurant.id,
        action: "package_updated_integration",
        packageId: existing.id,
        restaurantId: restaurant.id,
        details: {
          sourcePlatform: platform,
          externalOrderNo: payload.externalOrderNo,
          from: currentStatus,
          to: incomingStatus,
        },
      });
    }

    return { ...getPackageById(existing.id), duplicate: true };
  });
}

function findPlatformRestaurant(platform, platformRestaurantId) {
  const normalizedPlatform = normalizePlatformInput(platform);
  const normalizedStoreId = trimmed(platformRestaurantId);
  if (!normalizedPlatform || !normalizedStoreId) {
    return null;
  }

  const account = getPlatformAccounts().find((item) =>
    item.active &&
    normalizePlatformInput(item.platform) === normalizedPlatform &&
    item.externalStoreId === normalizedStoreId
  );

  if (!account) {
    return null;
  }

  const restaurant = getRestaurants({ restaurantId: account.restaurantId })[0] || null;
  if (!restaurant) {
    return null;
  }

  return { account, restaurant };
}

function requestHasGlobalWebhookSecret(req) {
  if (!WEBHOOK_SECRET) return false;
  return [
    req.headers["x-webhook-secret"],
    req.headers["x-platform-secret"],
    req.headers["x-api-key"],
    getBearerToken(req),
  ].some((value) => timingSafeStringEqual(value, WEBHOOK_SECRET));
}

function findAuthorizedPlatformWebhookAccount(platform, req, rawBody) {
  const normalizedPlatform = normalizePlatformInput(platform);
  const accounts = getPlatformAccounts().filter((account) =>
    account.active && normalizePlatformInput(account.platform) === normalizedPlatform
  );
  for (const account of accounts) {
    const restaurant = getRestaurants({ restaurantId: account.restaurantId })[0] || null;
    if (!restaurant) continue;
    const adapter = getPlatformAdapter(normalizePlatformKey(account.platform));
    const signature = verifyPlatformSignature({ req, account, restaurant, rawBody });
    if (
      signature.ok ||
      adapter.verifyWebhook(req, account) ||
      verifySimplePlatformSecret(account, restaurant, req) ||
      verifyPlatformWebhookAuth(account, req, rawBody)
    ) {
      return { account, restaurant };
    }
  }
  return null;
}

function createSimplePlatformPayload(order, restaurant) {
  const source = order.source === "platform_polling" ? "platform_polling" : "platform_webhook";
  return {
    source,
    sourcePlatform: order.platform,
    platformRestaurantId: order.platformRestaurantId || restaurant.externalStoreId || "",
    externalRestaurantId: order.platformRestaurantId || restaurant.externalStoreId || "",
    externalOrderNo: order.orderId,
    externalOrderId: order.orderId,
    posentegraId: resolvePackagePosentegraId({
      pid: order.pid,
      posentegraId: order.posentegraId ?? order.posentegra_id,
      externalOrderId: order.orderId,
    }),
    recipient: order.customerName,
    phone: order.phone,
    address: order.address,
    customerAddress: order.customerAddress || order.address,
    customerLatitude: Number.isFinite(Number(order.customerLatitude)) ? Number(order.customerLatitude) : null,
    customerLongitude: Number.isFinite(Number(order.customerLongitude)) ? Number(order.customerLongitude) : null,
    zone: restaurant.zone,
    eta: `${suggestedRestaurantPrepMinutes(restaurant.zone)} dk`,
    paymentMethod: order.paymentMethod || "Online Odeme",
    orderAmount: order.totalPrice,
    paymentStatus: normalizePaymentStatus("", order.paymentMethod || "Online Odeme"),
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
    note: order.customerNote || "Platform siparisi",
    customerNote: order.customerNote || "",
    items: Array.isArray(order.items) ? order.items : [],
    rawPayload: order.rawPayload || order,
    status: PENDING_APPROVAL_STATUS,
    assignmentStatus: "pending_approval",
    assignmentReason: "Platform siparisi restoran onayi bekliyor.",
  };
}

function handleSimplePlatformOrder(order, isManual = false, options = {}) {
  const match = findPlatformRestaurant(order.platform, order.platformRestaurantId);
  if (!match) {
    return { ok: false, error: "Restaurant not found", statusCode: 404 };
  }

  logger.info("Platform matched", {
    platform: match.account.platform,
    restaurantId: match.restaurant.id,
    platformRestaurantId: match.account.externalStoreId,
  });

  const payload = createSimplePlatformPayload({
    ...order,
    platform: match.account.platform,
  }, match.restaurant);
  
  if (isManual) {
    payload.status = AWAITING_ASSIGNMENT_STATUS;
    payload.assignmentStatus = "unassigned";
    payload.assignmentReason = "Manuel platform siparisi onaylanarak havuza alindi.";
  }
  
  const platformOrderId = upsertPlatformOrderRecord({ ...order, platform: match.account.platform }, match.restaurant.id, isManual ? "accepted" : "pending_approval", {
    requestId: options.requestId || null,
  });
  const created = upsertPlatformPackage(match.account.platform, match.restaurant, payload, {
    requestId: options.requestId || null,
  });
  if (isManual && created?.id) {
    rebalancePackages();
  }
  logger.info("Package created from platform order", {
    platform: match.account.platform,
    restaurantId: match.restaurant.id,
    orderId: order.orderId,
    packageId: created?.id || null,
    trackingNo: created?.trackingNo || null,
    source: payload.source,
  });
  broadcastLiveEvent({
    type: "platform-order-pending",
    restaurantId: match.restaurant.id,
    packageId: created?.id || null,
    source: isManual ? "platform_manual" : payload.source,
    suppressRestaurantAlert: isManual,
    message: "Yeni platform siparisi geldi.",
  });

  return {
    ok: true,
    restaurant: match.restaurant,
    account: match.account,
    package: created,
    platformOrder: getPlatformOrderById(platformOrderId),
  };
}

function connectorForPlatform(platform) {
  return platformConnectors[normalizePlatformInput(platform) || platform] || null;
}

async function testPlatformAccountAutomatically(account) {
  const strategy = testStrategyForAccount(account);
  if (strategy === "local_webhook") {
    if (IS_PRODUCTION) {
      return {
        ok: true,
        status: 200,
        strategy,
        optional: true,
        message: "Webhook bilgileri kaydedildi. Hesap ilk gercek platform siparisi geldiginde otomatik dogrulanacak.",
      };
    }
    const result = handleSimplePlatformOrder({
      platform: account.platform,
      platformRestaurantId: account.externalStoreId,
      orderId: `TEST-${Date.now()}`,
      customerName: "Test Musteri",
      phone: "05555555555",
      address: "Mersin Test Adresi",
      totalPrice: 250,
      paymentMethod: "Online Odeme",
      customerNote: "Entegrasyon Merkezi test siparisi",
      items: [{ id: "test-1", name: "Test Menu", quantity: 1, price: 250 }],
    });
    return result.ok
      ? {
          ok: true,
          status: 200,
          strategy,
          message: "Bağlantı başarılı. Webhook dogrulama siparisi olusturuldu.",
          package: result.package,
        }
      : {
          ok: false,
          status: result.statusCode || 404,
          strategy,
          message: platformFriendlyError(result.error, account.platform),
        };
  }

  const connector = connectorForPlatform(account.platform);
  if (!connector || typeof connector.testConnection !== "function") {
    return optionalIntegrationResult("Bu platform için otomatik bağlantı doğrulaması bulunamadı. Webhook modu kullanılacak.");
  }
  if (platformAccountMissingCredentials(account)) {
    return {
      ...optionalIntegrationResult(platformFriendlyError("API bilgileri eksik", account.platform)),
      strategy,
    };
  }

  try {
    const result = await connector.testConnection(account);
    return {
      ...result,
      strategy,
      message: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
    };
  } catch (error) {
    return {
      ok: false,
      status: "timeout",
      strategy,
      message: platformFriendlyError(error.message, account.platform),
    };
  }
}

const posMissingEndpointLogKeys = new Set();

async function pollPlatformAccount(account, options = {}) {
  if (!account.pollingEnabled) {
    logger.info("Polling skipped", {
      platform: account.platform,
      accountId: account.id,
      reason: "polling_enabled false",
    });
    return {
      ok: false,
      skipped: true,
      optional: true,
      reason: "Polling kapali veya API bilgileri eksik",
    };
  }
  if (!options.manual && !PLATFORM_POLLING_ENABLED) {
    return {
      ok: false,
      skipped: true,
      optional: true,
      reason: "Polling API kapalı — webhook ile sipariş bekleniyor.",
    };
  }
  const connector = connectorForPlatform(account.platform);
  if (!connector || typeof connector.fetchOrders !== "function") {
    return { ok: false, skipped: true, reason: "connector yok" };
  }
  const isPosAccount = normalizePlatformInput(account.platform) === "POS";
  if (platformAccountMissingCredentials(account)) {
    return { ok: false, skipped: true, optional: true, reason: "Polling kapali veya API bilgileri eksik" };
  }
  if (!isPosAccount && account.verificationStatus !== PLATFORM_VERIFICATION_STATUS.VERIFIED) {
    return { ok: false, skipped: true, reason: "API baglanti testi basarili olmadan polling calismaz." };
  }
  if (isPosAccount && !options.manual && typeof connector.endpointConfigured === "function" && !connector.endpointConfigured(account)) {
    const logKey = `${account.id}:missing_endpoint`;
    if (!posMissingEndpointLogKeys.has(logKey)) {
      posMissingEndpointLogKeys.add(logKey);
      logger.warn("POS polling skipped", {
        accountId: account.id,
        platformRestaurantId: account.externalStoreId,
        endpointConfigured: false,
        reason: "API endpoint eksik",
      });
    }
    return {
      ok: false,
      skipped: true,
      optional: true,
      reason: "POS API endpoint eksik. ADISYO_API_BASE_URL veya ADISYO_POLLING_URL tanimlayin.",
    };
  }

  let rawOrders = [];
  try {
    rawOrders = await connector.fetchOrders(account);
  } catch (error) {
    if (error.code === "POS_ENDPOINT_MISSING") {
      const logKey = `${account.id}:missing_endpoint`;
      if (options.manual || !posMissingEndpointLogKeys.has(logKey)) {
        posMissingEndpointLogKeys.add(logKey);
        logger.warn("POS polling skipped", {
          accountId: account.id,
          platformRestaurantId: account.externalStoreId,
          endpointConfigured: false,
          reason: "API endpoint eksik",
        });
      }
      return {
        ok: false,
        skipped: true,
        optional: true,
        reason: "POS API endpoint eksik. ADISYO_API_BASE_URL veya ADISYO_POLLING_URL tanimlayin.",
      };
    }
    logger.error("Platform polling connector failed", {
      platform: account.platform,
      accountId: account.id,
      error,
    });
    return { ok: false, skipped: true, reason: "Platform polling tamamlanamadi, manuel paket sistemi kullanilabilir." };
  }
  const createdOrders = rawOrders.filter((rawOrder) => isPollableCreatedPlatformOrder(account.platform, rawOrder));
  let createdCount = 0;
  for (const rawOrder of createdOrders) {
    const normalized = connector.normalizeOrder({
      ...rawOrder,
      platform: account.platform,
      platformRestaurantId: rawOrder?.platformRestaurantId || rawOrder?.platform_restaurant_id || account.externalStoreId,
    });
    const order = normalizeOrder(account.platform, {
      ...normalized,
      platform: account.platform,
      platformRestaurantId: normalized.platformRestaurantId || account.externalStoreId,
    });
    const existing = db.prepare(`
      SELECT id FROM platform_orders
      WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
    `).get(account.platform, order.orderId, account.restaurantId);
    const result = handleSimplePlatformOrder(order);
    if (result.ok && !existing) {
      createdCount += 1;
      logger.info("Platform order saved from polling", {
        platform: account.platform,
        accountId: account.id,
        restaurantId: account.restaurantId,
        platformRestaurantId: order.platformRestaurantId,
        orderId: order.orderId,
        packageId: result.package?.id || null,
        status: result.package?.status || PENDING_APPROVAL_STATUS,
      });
      if (typeof connector.acknowledgeOrder === "function") {
        await connector.acknowledgeOrder(order);
      }
    }
  }

  db.prepare("UPDATE platform_accounts SET last_poll_at = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), nowIso(), account.id);
  return { ok: true, createdCount, fetchedCount: rawOrders.length, createdStatusCount: createdOrders.length };
}

let platformPollingRunning = false;

async function pollPlatformAccounts() {
  if (platformPollingRunning) {
    return;
  }
  platformPollingRunning = true;
  try {
    const accounts = getPlatformAccounts().filter((account) => account.active);
    for (const account of accounts) {
      try {
        await pollPlatformAccount(account);
      } catch (error) {
        db.prepare(`
          UPDATE platform_accounts
          SET verification_status = ?, verification_note = ?, updated_at = ?
          WHERE id = ?
        `).run(
          PLATFORM_VERIFICATION_STATUS.PENDING,
          `Polling tamamlanamadi: ${error.message}`,
          nowIso(),
          account.id
        );
      }
    }
  } finally {
    platformPollingRunning = false;
  }
}

function getPackageById(packageId) {
  const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
  if (!row) {
    return null;
  }
  const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(row.restaurant_id);
  return mapPackageRow(row, new Map([[row.restaurant_id, restaurant?.name || "Bilinmeyen Restoran"]]));
}

function appendPlatformStatusLog(packageId, entry) {
  const target = db.prepare("SELECT platform_status_logs_json FROM packages WHERE id = ?").get(packageId);
  if (!target) {
    return [];
  }

  const logs = parseJson(target.platform_status_logs_json, []);
  const nextLogs = logs.concat({
    id: uid("plog"),
    status: entry.status,
    message: entry.message,
    platform: entry.platform,
    createdAt: nowIso(),
    meta: entry.meta || {},
  });
  db.prepare("UPDATE packages SET platform_status_logs_json = ?, updated_at = ? WHERE id = ?").run(
    json(nextLogs),
    nowIso(),
    packageId
  );
  return nextLogs;
}

async function callPlatformStatusCallback(packageRecord, status, meta = {}) {
  if (!packageRecord || !packageRecord.sourcePlatform || !isPlatformBackedPackage(packageRecord)) {
    return { ok: false };
  }

  const orderData = {
    orderId: packageRecord.externalOrderId || packageRecord.externalOrderNo,
    restaurantId: packageRecord.restaurantId,
    courierId: packageRecord.assignedCourierId || null,
    status,
    meta,
  };
  let result;
  try {
    result = await sendPlatformStatusCallback({ db, packageRecord, status, meta });
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  if (result?.mode === "not_configured" || result?.status === "not_configured") {
    if (callbackOutcomeAlreadyRecorded(packageRecord, status, meta, result)) {
      logger.debug("Platform status callback duplicate skip suppressed", {
        packageId: packageRecord.id,
        platform: packageRecord.sourcePlatform,
        status,
        courierId: meta?.courierId || packageRecord.assignedCourierId || null,
      });
      return { ...result, deduplicated: true };
    }
    logger.info("Platform status callback skipped", {
      packageId: packageRecord.id,
      platform: packageRecord.sourcePlatform,
      status,
      reason: result?.error || "callback_not_configured",
    });
    appendPlatformStatusLog(packageRecord.id, {
      status,
      message: `platform ${status} callback atlandi: ${result?.error || "callback_not_configured"}`,
      platform: packageRecord.sourcePlatform,
      meta: { ...meta, callbackMode: result?.mode || null, callbackStatus: result?.status || null },
    });
    logPlatformEvent({
      platform: packageRecord.sourcePlatform,
      restaurantId: packageRecord.restaurantId,
      platformAccountId: result?.platformAccountId || null,
      eventType: "callback",
      status: "skipped",
      httpStatus: null,
      errorCode: null,
      errorMessage: result?.error || "callback_not_configured",
      metadata: { packageId: packageRecord.id, callbackMode: result?.mode || null, callbackStatus: result?.status || null },
    });
    return result;
  }
  const message = result?.ok
    ? `platforma ${status} bildirildi`
    : `platform ${status} callback basarisiz: ${result?.error || result?.status || "unknown"}`;
  appendPlatformStatusLog(packageRecord.id, {
    status,
    message,
    platform: packageRecord.sourcePlatform,
    meta: { ...meta, callbackMode: result?.mode || null, callbackStatus: result?.status || null },
  });
  writeAuditLog({
    actorRole: "integration",
    actorId: packageRecord.restaurantId,
    action: "platform_status_callback",
    packageId: packageRecord.id,
    restaurantId: packageRecord.restaurantId,
    details: {
      platform: packageRecord.sourcePlatform,
      status,
      meta,
    },
  });
  logger[result?.ok ? "info" : "warn"]("Platform status callback completed", {
    packageId: packageRecord.id,
    platform: packageRecord.sourcePlatform,
    status,
    ok: Boolean(result?.ok),
    mode: result?.mode || null,
    callbackStatus: result?.status || null,
    error: result?.error || null,
  });
  logPlatformEvent({
    platform: packageRecord.sourcePlatform,
    restaurantId: packageRecord.restaurantId,
    platformAccountId: result?.platformAccountId || null,
    eventType: "callback",
    status: result?.ok ? "success" : "error",
    httpStatus: Number(result?.status) || null,
    errorCode: result?.ok ? null : HEALTH_ERROR_CODES.CALLBACK_FAILED,
    errorMessage: result?.ok ? null : (result?.error || "callback_failed"),
    metadata: { packageId: packageRecord.id, callbackMode: result?.mode || null, callbackStatus: result?.status || null },
  });
  if (result?.platformAccountId) {
    db.prepare(`
      UPDATE platform_accounts
      SET last_callback_at = ?,
          connection_status = CASE WHEN ? THEN 'connected' ELSE connection_status END,
          last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
          last_error_at = CASE WHEN ? THEN last_error_at ELSE ? END,
          last_error_code = CASE WHEN ? THEN last_error_code ELSE ? END,
          last_error_message = CASE WHEN ? THEN last_error_message ELSE ? END,
          consecutive_failures = CASE WHEN ? THEN 0 ELSE COALESCE(consecutive_failures, 0) + 1 END,
          updated_at = ?
      WHERE id = ?
    `).run(
      nowIso(),
      result.ok ? 1 : 0,
      result.ok ? 1 : 0,
      nowIso(),
      result.ok ? 1 : 0,
      nowIso(),
      result.ok ? 1 : 0,
      HEALTH_ERROR_CODES.CALLBACK_FAILED,
      result.ok ? 1 : 0,
      result?.error || "callback_failed",
      result.ok ? 1 : 0,
      nowIso(),
      result.platformAccountId
    );
  }
  if (!result?.ok) {
    const webhookLogId = logWebhookAttempt({
      restaurantId: packageRecord.restaurantId,
      sourcePlatform: packageRecord.sourcePlatform,
      externalOrderNo: orderData.orderId,
      signatureValid: true,
      responseStatus: Number(result?.status) || 502,
      requestBody: json({ type: "platform_status_callback", status, orderData, result }),
      retryCount: 0,
      nextRetryAt: new Date(Date.now() + 30000).toISOString(),
      lastError: result?.error || "callback_failed",
    });
    queueService.enqueue(JOB_TYPES.WEBHOOK_CALLBACK_RETRY, {
      webhookLogId,
      packageId: packageRecord.id,
      platform: packageRecord.sourcePlatform,
      status,
      meta,
      orderData,
      lastError: result?.error || "callback_failed",
      createdAt: nowIso(),
    }, {
      jobId: webhookLogId ? `webhook-callback-${webhookLogId}` : undefined,
    }).then((queueResult) => {
      if (queueResult.ok) {
        logger.warn("Platform callback retry queued", {
          packageId: packageRecord.id,
          platform: packageRecord.sourcePlatform,
          status,
          jobId: queueResult.jobId,
        });
      } else {
        logger.warn("Platform callback retry inline fallback", {
          packageId: packageRecord.id,
          platform: packageRecord.sourcePlatform,
          status,
          reason: queueResult.reason,
        });
      }
    });
  }
  return result;
}

function notifyPlatformOrderAccepted(platform, orderId, restaurantId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "accepted", orderId, restaurantId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "accepted", { orderId, restaurantId });
}

function notifyPlatformOrderRejected(platform, orderId, reason, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "rejected", orderId, reason });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "rejected", { orderId, reason });
}

function notifyPlatformOrderPreparing(platform, orderId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "preparing", orderId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "preparing", { orderId });
}

function notifyPlatformOrderAssigned(platform, orderId, courierId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "assigned", orderId, courierId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "assigned", { orderId, courierId });
}

function notifyPlatformOrderDelivered(platform, orderId, packageRecord = null) {
  const target = packageRecord || getPackageById(orderId);
  const targetPlatform = normalizePlatformName(target?.sourcePlatform || platform);
  const posentegraId = resolvePackagePosentegraId(target);
  if (target && targetPlatform && isPlatformBackedPackage(target) && posentegraId && posentegraClient.configured()) {
    const dedupeKey = `order.status:${target.id}:${DELIVERED_STATUS}`;
    const outboxRow = db.prepare("SELECT * FROM posentegra_outbox WHERE dedupe_key = ?").get(dedupeKey)
      || enqueuePosentegraStatusChange(target, DELIVERED_STATUS);
    logger.info("Platform delivery status queued for Posentegra", {
      platform: targetPlatform,
      orderId,
      packageId: target.id,
      posentegraId,
      outboxId: outboxRow?.id || null,
      outboxStatus: outboxRow?.status || null,
    });
    appendPlatformStatusLog(target.id, {
      status: DELIVERED_STATUS,
      message: `${targetPlatform} teslim durumu Posentegra kuyruguna alindi.`,
      platform: targetPlatform,
      meta: {
        callbackMode: "posentegra_outbox",
        posentegraId,
        outboxId: outboxRow?.id || null,
      },
    });
    return Promise.resolve({
      ok: Boolean(outboxRow),
      mode: "posentegra_outbox",
      status: outboxRow?.status || "queue_unavailable",
      outboxId: outboxRow?.id || null,
    });
  }
  logger.info("Platform status callback requested", { platform, status: "delivered", orderId });
  return callPlatformStatusCallback(target, "delivered", { orderId });
}

function resolvePlatformAccountForWebhook(platform, req, body) {
  const normalizedPlatform = normalizePlatformName(platform);
  const identifiers = new Set([
    ...extractPlatformIdentifiers(body),
    ...candidateHeaderValues(req, ["x-store-id", "x-vendor-id", "x-merchant-id", "x-seller-id", "x-chain-id"]),
  ]);

  const accounts = getPlatformAccounts().filter((account) => account.platform === normalizedPlatform && account.active);
  if (accounts.length === 1) {
    return accounts[0];
  }

  return accounts.find((account) =>
    identifiers.has(account.externalStoreId) ||
    (account.externalMerchantId && identifiers.has(account.externalMerchantId)) ||
    (account.chainId && identifiers.has(account.chainId)) ||
    (account.vendorId && identifiers.has(account.vendorId))
  ) || null;
}

function getCourierSession(req) {
  return getSessionByToken("courier_sessions", "token", getBearerToken(req), COURIER_SESSION_MAX_AGE_MS);
}

function getRestaurantSession(req) {
  return getSessionByToken("restaurant_sessions", "token", getBearerToken(req), RESTAURANT_SESSION_MAX_AGE_MS);
}

const existingAdmin = db.prepare("SELECT id FROM admins LIMIT 1").get();
if (!existingAdmin) {
  const configuredAdminUsername = trimmed(process.env.DELIVERA_ADMIN_USERNAME || "admin").toLowerCase();
  const configuredAdminPassword = process.env.DELIVERA_ADMIN_PASSWORD || "";
  if (IS_PRODUCTION && !configuredAdminPassword) {
    throw new Error("DELIVERA_ADMIN_PASSWORD is required to create the first admin in production.");
  }
  const defaultAdminUsername = configuredAdminUsername;
  const defaultAdminPassword = configuredAdminPassword || `Adm${crypto.randomBytes(6).toString("hex")}!`;
  const passwordInfo = hashPassword(defaultAdminPassword);
  db.prepare("INSERT INTO admins (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(
    uid("adm"),
    defaultAdminUsername,
    passwordInfo.hash,
    passwordInfo.salt,
    new Date().toISOString()
  );

  fs.writeFileSync(
    ADMIN_BOOTSTRAP_FILE,
    `RESTOMAP ilk admin hesabi olusturuldu.\nKullanici adi: ${defaultAdminUsername}\nSifre: ${defaultAdminPassword}\n`,
    "utf8"
  );
}

async function handleApi(req, res, pathname) {
  const originalPathname = pathname;
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const url = requestUrl;
  if (req.method === "GET" && pathname === "/api/system-curtain/status") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    sendJson(res, 200, { ok: true, ...getSystemCurtainState() });
    return;
  }
  if (req.method === "POST") {
    const createAliases = {
      "/restaurants": "/api/admin/restaurants",
      "/api/restaurants": "/api/admin/restaurants",
      "/couriers": "/api/admin/couriers",
      "/api/couriers": "/api/admin/couriers",
      "/packages": "/api/restaurant/packages",
      "/api/packages": "/api/restaurant/packages",
      "/platform-orders": "/api/restaurant/platform-orders/manual",
      "/api/platform-orders": "/api/restaurant/platform-orders/manual",
    };
    if (createAliases[pathname]) {
      pathname = createAliases[pathname];
      logger.info("CREATE_ENDPOINT_ALIAS_APPLIED", {
        requestId: req.requestId,
        method: req.method,
        originalPath: originalPathname,
        routedPath: pathname,
      });
    }
  }

  const generalRetry = await applyRateLimit(req, "general", RATE_LIMITS.general);
  if (generalRetry !== null) {
    sendRateLimited(res, generalRetry);
    return;
  }

  if (pathname === "/api/external/restaurants" && req.method === "GET") {
    if (!requireExternalApiKey(req, res)) return;
    const restaurants = getRestaurants().map(externalRestaurantPayload);
    logger.info("external_restaurants_listed", {
      request_id: req.requestId,
      count: restaurants.length,
    });
    sendJson(res, 200, restaurants);
    return;
  }

  if (pathname === "/api/external/packages" && req.method === "GET") {
    if (!requireExternalApiKey(req, res)) return;
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const onlyActive = requestUrl.searchParams.get("active") !== "0";
    const packages = getPackages()
      .filter((pkg) => !onlyActive || ![DELIVERED_STATUS, FAILED_STATUS, CANCELED_STATUS, REJECTED_STATUS].includes(normalizeStatus(pkg.status)))
      .map(externalPackagePayload);
    logger.info("external_packages_listed", {
      request_id: req.requestId,
      count: packages.length,
    });
    sendJson(res, 200, packages);
    return;
  }

  const externalPackageMatch = pathname.match(/^\/api\/external\/packages\/([^/]+)$/);
  if (externalPackageMatch && req.method === "GET") {
    if (!requireExternalApiKey(req, res)) return;
    const pkg = getPackageById(externalPackageMatch[1]);
    if (!pkg) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }
    sendJson(res, 200, externalPackagePayload(pkg));
    return;
  }

  if (pathname === "/api/external/platform-orders" && req.method === "POST") {
    if (!requireExternalApiKey(req, res)) return;
    const { json: body } = await readRequestBody(req);
    const result = createOrGetExternalPlatformOrder(body, req);
    if (result.unmatched) {
      sendJson(res, 202, {
        ok: true,
        matched: false,
        unmatchedOrderId: result.unmatchedOrderId,
        message: "Siparis alindi ve Eslestirilemeyen Siparisler kuyruguna kaydedildi.",
      });
      return;
    }
    sendJson(res, result.duplicate ? 200 : 201, {
      ok: true,
      duplicate: result.duplicate,
      platformOrder: result.platformOrder,
      package: externalPackagePayload(result.package),
    });
    return;
  }

  const externalPackageStatusMatch = pathname.match(/^\/api\/external\/packages\/([^/]+)\/status$/);
  if (externalPackageStatusMatch && req.method === "PATCH") {
    if (!requireExternalApiKey(req, res)) return;
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(externalPackageStatusMatch[1]);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    if (!isKnownExternalPackageStatus(body.status)) {
      sendJson(res, 400, { error: "Gecersiz paket durumu." });
      return;
    }
    const nextStatus = internalStatusFromExternal(body.status);
    updatePackageLifecycle(target.id, { status: nextStatus }, mapPackageRow(target));
    const updated = getPackageById(target.id);
    logger.info("package_status_updated", {
      request_id: req.requestId,
      internal_restaurant_id: updated.restaurantId,
      platform: platformApiKey(updated.platform || updated.sourcePlatform || updated.source),
      platform_restaurant_id: updated.platformRestaurantId || null,
      platform_order_id: updated.platformOrderId || null,
      package_id: updated.id,
      tracking_no: updated.trackingNo,
    });
    sendJson(res, 200, {
      ok: true,
      package: externalPackagePayload(updated),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/webhooks/health") {
    sendJson(res, 200, {
      ok: true,
      enabled: WEBHOOK_ENABLED,
      secretConfigured: Boolean(WEBHOOK_SECRET),
      allowedIpsConfigured: WEBHOOK_ALLOWED_IPS.length > 0,
    });
    return;
  }

  if (req.method === "POST" && ["/api/webhooks/orders", "/api/webhooks/order"].includes(pathname)) {
    const retryAfter = await applyRateLimit(req, "platformOrder", RATE_LIMITS.platformOrder);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    if (!WEBHOOK_ENABLED) {
      sendJson(res, 503, { success: false, message: "Webhook endpoint disabled" });
      return;
    }
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      sendJson(res, 415, { success: false, message: "Content-Type application/json olmalidir." });
      return;
    }
    const incomingIp = clientIp(req);
    if (WEBHOOK_ALLOWED_IPS.length > 0 && !WEBHOOK_ALLOWED_IPS.includes(incomingIp)) {
      logApiWebhookAttempt({ req, order: null, httpStatus: 401, status: "error", errorMessage: "IP not allowed" });
      sendJson(res, 401, { success: false, message: "Unauthorized webhook request" });
      return;
    }
    let body;
    try {
      ({ json: body } = await readRequestBody(req));
    } catch (error) {
      sendJson(res, error.statusCode || 400, { success: false, message: error.message });
      return;
    }
    const order = applyWebhookRestaurantIdFallback(req, normalizeWebhookOrderPayload(body));
    if (!apiWebhookAuthorized(req, order)) {
      logApiWebhookAttempt({ req, order, httpStatus: 401, status: "error", errorMessage: "Unauthorized webhook request" });
      sendJson(res, 401, { success: false, message: "Unauthorized webhook request" });
      return;
    }
    if (order.posentegraId) {
      logger.info("posentegra_id_detected", {
        request_id: req.requestId,
        pid: order.posentegraId,
        posentegra_id: order.posentegraId,
        platform: platformApiKey(order.platform || order.platformSlug),
        platform_restaurant_id: order.externalRestaurantId || null,
        platform_order_id: order.externalOrderId || order.confirmationId || null,
        provider_slug: order.platformSlug || null,
      });
    }
    try {
      const restaurant = findRestaurantByExternalRestaurantId(order.externalRestaurantId, order.platformSlug || order.platform);
      if (!restaurant) {
        const unmatchedId = persistUnmatchedIncomingOrder(order, req, { httpStatus: 200 });
        sendWebhookPosTicket(res, unmatchedId, {
          success: true,
          matched: false,
          unmatchedOrderId: unmatchedId,
          message: "Order accepted as unmatched",
        });
        return;
      }
      if (order.posentegraId) {
        logger.info("posentegra_restaurant_matched", {
          request_id: req.requestId,
          pid: order.posentegraId,
          posentegra_id: order.posentegraId,
          platform: platformApiKey(order.platform || order.platformSlug),
          platform_restaurant_id: order.externalRestaurantId || null,
          internal_restaurant_id: restaurant.id,
          platform_order_id: order.externalOrderId || order.confirmationId || null,
        });
      }

      const result = upsertWebhookPackage(order, restaurant, { requestId: req.requestId });
      resolveUnmatchedOrderForMatchedPackage(order, restaurant.id, result.packageId);
      rebalancePackages();
      const createdPackage = getPackageById(result.packageId);
      logApiWebhookAttempt({ req, order, restaurantId: restaurant.id, isMatched: true, httpStatus: 200, status: result.duplicate ? "updated" : "created" });
      writeAuditLog({
        actorRole: "webhook",
        actorId: order.providerName || order.platform,
        action: result.duplicate ? "webhook_order_updated" : "webhook_order_created",
        packageId: result.packageId,
        restaurantId: restaurant.id,
        details: {
          platform: order.platform,
          externalOrderId: order.externalOrderId,
          externalRestaurantId: order.externalRestaurantId,
          posentegraId: order.posentegraId,
          duplicate: result.duplicate,
        },
      });
      const webhookEventType = result.duplicate ? "package-status" : "order:new";
      broadcastLiveEvent({
        type: webhookEventType,
        restaurantId: restaurant.id,
        courierId: createdPackage?.assignedCourierId || null,
        message: result.duplicate
          ? `${order.platform} siparis durumu ${createdPackage?.status || order.status} olarak guncellendi.`
          : `Yeni ${order.platform} siparisi geldi.`,
        orderId: result.packageId,
        platform: order.platform,
        customerName: order.customerName,
        totalPrice: order.discountedPrice || order.totalPrice,
        shortCode: order.shortCode,
      });
      sendWebhookPosTicket(res, webhookPosTicketForPackage(createdPackage, result.packageId, order), {
        success: true,
        matched: true,
        duplicate: result.duplicate,
        orderId: result.packageId,
        package: createdPackage,
      });
      return;
    } catch (error) {
      logger.error("API webhook order failed", { error, requestId: req.requestId });
      logApiWebhookAttempt({ req, order, httpStatus: error.statusCode || 500, status: "error", errorMessage: error.message });
      sendJson(res, error.statusCode || 500, { success: false, message: error.message || "Webhook order failed" });
      return;
    }
  }

  if (req.method === "POST" && ["/api/webhooks/orders/cancel", "/api/webhooks/cancel"].includes(pathname)) {
    const retryAfter = await applyRateLimit(req, "platformOrder", RATE_LIMITS.platformOrder);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    if (!WEBHOOK_ENABLED) {
      sendJson(res, 503, { success: false, message: "Webhook endpoint disabled" });
      return;
    }
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      sendJson(res, 415, { success: false, message: "Content-Type application/json olmalidir." });
      return;
    }
    const incomingIp = clientIp(req);
    if (WEBHOOK_ALLOWED_IPS.length > 0 && !WEBHOOK_ALLOWED_IPS.includes(incomingIp)) {
      logApiWebhookAttempt({ req, order: null, httpStatus: 401, status: "error", errorMessage: "IP not allowed" });
      sendJson(res, 401, { success: false, message: "Unauthorized webhook request" });
      return;
    }

    let body;
    try {
      ({ json: body } = await readRequestBody(req));
    } catch (error) {
      sendJson(res, error.statusCode || 400, { success: false, message: error.message });
      return;
    }

    const order = applyWebhookRestaurantIdFallback(req, normalizeWebhookOrderPayload({ ...body, status: body.status || "cancelled" }));
    if (!apiWebhookAuthorized(req, order)) {
      logApiWebhookAttempt({ req, order, httpStatus: 401, status: "error", errorMessage: "Unauthorized webhook request" });
      sendJson(res, 401, { success: false, message: "Unauthorized webhook request" });
      return;
    }

    try {
      const restaurant = findRestaurantByExternalRestaurantId(order.externalRestaurantId, order.platformSlug || order.platform);
      if (!restaurant) {
        logPlatformRestaurantNotMatched(order, req);
        logApiWebhookAttempt({ req, order, isMatched: false, httpStatus: 200, status: "unmatched" });
        broadcastLiveEvent({
          type: "order:cancel-unmatched",
          message: `Eslestirilemeyen platform iptali alindi: ${order.externalRestaurantId || "-"}`,
        });
        sendWebhookPosTicket(res, order.externalOrderId || order.posentegraId || "unmatched-cancel", {
          success: true,
          matched: false,
          message: "Cancel accepted as unmatched",
        });
        return;
      }

      const target = findWebhookPackageForOrder(order, restaurant.id);
      if (!target) {
        logApiWebhookAttempt({ req, order, restaurantId: restaurant.id, isMatched: true, httpStatus: 200, status: "unmatched" });
        sendWebhookPosTicket(res, order.externalOrderId || order.posentegraId || "missing-cancel", {
          success: true,
          matched: true,
          cancelled: false,
          message: "Cancel accepted but matching order was not found",
        });
        return;
      }

      updatePackageLifecycle(target.id, {
        status: CANCELED_STATUS,
        assignmentStatus: "cancelled",
        failureReason: trimmed(body.reason || body.cancelReason || body.cancellationReason) || "Platform iptal bildirimi.",
      }, mapPackageRow(target));
      db.prepare(`
        UPDATE packages
        SET assigned_courier_id = NULL,
            assigned_courier_name = NULL,
            assigned_at = NULL,
            last_assignment_attempt_at = NULL,
            last_assignment_error = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(nowIso(), target.id);
      updatePlatformOrderStatusByPackage(target, "cancelled");
      const cancelledPackage = getPackageById(target.id);
      logApiWebhookAttempt({ req, order, restaurantId: restaurant.id, isMatched: true, httpStatus: 200, status: "cancelled" });
      writeAuditLog({
        actorRole: "webhook",
        actorId: order.providerName || order.platform,
        action: "webhook_order_cancelled",
        packageId: target.id,
        restaurantId: restaurant.id,
        details: {
          platform: order.platform,
          externalOrderId: order.externalOrderId,
          externalRestaurantId: order.externalRestaurantId,
          posentegraId: order.posentegraId,
          reason: trimmed(body.reason || body.cancelReason || body.cancellationReason),
        },
      });
      broadcastLiveEvent({
        type: "order:cancelled",
        restaurantId: restaurant.id,
        orderId: target.id,
        platform: order.platform,
        message: `${order.platform || "Platform"} siparisi iptal edildi.`,
      });
      sendWebhookPosTicket(res, webhookPosTicketForPackage(cancelledPackage, target.id, order), {
        success: true,
        matched: true,
        cancelled: true,
        orderId: target.id,
        package: cancelledPackage,
      });
      return;
    } catch (error) {
      logger.error("API webhook cancel failed", { error, requestId: req.requestId });
      logApiWebhookAttempt({ req, order, httpStatus: error.statusCode || 500, status: "error", errorMessage: error.message });
      sendJson(res, error.statusCode || 500, { success: false, message: error.message || "Webhook cancel failed" });
      return;
    }
  }

  if (req.method === "GET" && pathname === "/api/admin/system-status") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, systemStatusPayload());
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/posentegra-outbox") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const requestedStatus = trimmed(requestUrl.searchParams.get("status"));
    const allowedStatuses = new Set(["pending", "processing", "failed", "completed", "dead_letter"]);
    const limit = clampLimit(requestUrl.searchParams.get("limit"), 100);
    const rows = requestedStatus && allowedStatuses.has(requestedStatus)
      ? db.prepare(`SELECT * FROM posentegra_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(requestedStatus, limit)
      : db.prepare(`SELECT * FROM posentegra_outbox ORDER BY created_at DESC LIMIT ?`).all(limit);
    sendJson(res, 200, {
      ok: true,
      health: posentegraOutbox.health(),
      items: rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
    return;
  }

  const posentegraOutboxReconcileMatch = pathname.match(/^\/api\/admin\/posentegra-outbox\/packages\/([^/]+)\/reconcile$/);
  if (req.method === "POST" && posentegraOutboxReconcileMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const packageId = decodeURIComponent(posentegraOutboxReconcileMatch[1]);
    try {
      const result = await posentegraOutbox.reconcilePackage(packageId);
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "posentegra_outbox_package_reconciled",
        details: result,
      });
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      logger.warn("Posentegra package reconciliation failed", { packageId, error: error.message });
      sendJson(res, Number(error.statusCode) || 502, { error: error.message });
    }
    return;
  }

  const posentegraOutboxRetryMatch = pathname.match(/^\/api\/admin\/posentegra-outbox\/([^/]+)\/retry$/);
  if (req.method === "POST" && posentegraOutboxRetryMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const outboxId = decodeURIComponent(posentegraOutboxRetryMatch[1]);
    const result = db.prepare(`
      UPDATE posentegra_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
          locked_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('failed', 'dead_letter')
    `).run(nowIso(), nowIso(), outboxId);
    if (!result.changes) {
      sendJson(res, 404, { error: "Tekrar denenebilir Posentegra outbox kaydi bulunamadi." });
      return;
    }
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "posentegra_outbox_retry_requested",
      details: { outboxId },
    });
    schedulePosentegraOutbox();
    sendJson(res, 202, { ok: true, outboxId, status: "pending" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/performance-summary") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, performanceSummaryPayload());
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/platform-health-summary") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const restaurantMap = new Map(getRestaurants().map((restaurant) => [restaurant.id, restaurant.name]));
    const accounts = getPlatformAccounts().map((account) => ({
      ...sanitizePlatformAccount(account, true),
      restaurantName: restaurantMap.get(account.restaurantId) || "Bilinmeyen Restoran",
      recentEvents: getPlatformEvents(5, { platformAccountId: account.id }),
    }));
    sendJson(res, 200, {
      ok: true,
      summary: platformHealthSummaryPayload(),
      accounts,
      recentEvents: getPlatformEvents(20),
    });
    return;
  }

  const adminPlatformHealthMatch = pathname.match(/^\/api\/admin\/platform-accounts\/([^/]+)\/health$/);
  if (req.method === "GET" && adminPlatformHealthMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const account = getPlatformAccounts().find((item) => item.id === adminPlatformHealthMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      account: sanitizePlatformAccount(account, true),
      health: buildHealthPayload(account),
      recentEvents: getPlatformEvents(20, { platformAccountId: account.id }),
    });
    return;
  }

  const adminPlatformCheckMatch = pathname.match(/^\/api\/admin\/platform-accounts\/([^/]+)\/check-connection$/);
  if (req.method === "POST" && adminPlatformCheckMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const account = getPlatformAccounts().find((item) => item.id === adminPlatformCheckMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await checkPlatformAccountConnection(account, req);
    sendJson(res, 200, {
      ok: true,
      account: result.account,
      health: result.account.connectionHealth,
      recentEvents: result.recentEvents,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      stats: statsFromDb(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/login") {
    const retryAfter = await applyRateLimit(req, "adminLogin", RATE_LIMITS.adminLogin);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { username, password } = validateAdminLoginDraft(body);
    const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
    if (!admin || !verifyPassword(password, admin.password_salt, admin.password_hash)) {
      sendJson(res, 401, { error: "Admin kullanici adi veya sifre hatali." });
      return;
    }

    const auth = issueSessionPair("admin", admin.id, req);

    writeAuditLog({
      actorRole: "admin",
      actorId: admin.id,
      action: "admin_logged_in",
      details: {
        username: admin.username,
      },
    });

    setSessionCookie(res, auth.token);
    sendJson(res, 200, { ...auth, username: admin.username });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/bootstrap") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const restaurantId = trimmed(requestUrl.searchParams.get("restaurantId"));
    const payload = decorateState({ restaurantId: restaurantId || undefined, req });
    payload.restaurants = getRestaurants().map((restaurant) => sanitizeRestaurant(restaurant));
    payload.auditLogs = getAuditLogs(20, { restaurantId: restaurantId || undefined });
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/reports/account") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const requestedDate = trimmed(requestUrl.searchParams.get("date")) || restaurantReportDayKey();
    const period = trimmed(requestUrl.searchParams.get("period")).toLowerCase() || "day";
    const startDate = trimmed(requestUrl.searchParams.get("startDate"));
    const endDate = trimmed(requestUrl.searchParams.get("endDate"));
    const statusFilter = trimmed(requestUrl.searchParams.get("status")).toLowerCase() || "all";
    const paymentFilter = trimmed(requestUrl.searchParams.get("payment")).toLowerCase() || "all";
    const restaurantId = trimmed(requestUrl.searchParams.get("restaurantId"));
    const validStatuses = new Set(["all", "delivered", "cancelled", "active", "failed"]);
    const validPayments = new Set(["all", "cash", "card", "online", "restaurant", "other"]);
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
    const rangeDays = period === "range" && validDate(startDate) && validDate(endDate)
      ? Math.floor((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000) + 1
      : 0;
    if (!validDate(requestedDate) || !["day", "week", "range"].includes(period) || !validStatuses.has(statusFilter) || !validPayments.has(paymentFilter)
      || (period === "range" && (!validDate(startDate) || !validDate(endDate) || rangeDays < 1 || rangeDays > 366))) {
      sendJson(res, 400, { error: "Gecersiz rapor filtresi." });
      return;
    }
    const reportRestaurants = getRestaurants().map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      zone: restaurant.zone || "",
    }));
    if (restaurantId && !reportRestaurants.some((restaurant) => restaurant.id === restaurantId)) {
      sendJson(res, 404, { error: "Raporlanacak isletme bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ...buildAccountOrderReport({ restaurantId, requestedDate, period, startDate, endDate, statusFilter, paymentFilter }),
      selectedRestaurantId: restaurantId,
      restaurants: reportRestaurants,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/system-curtain/control") {
    const suppliedToken = trimmed(req.headers["x-delivera-curtain-control"]);
    if (!systemCurtainControlTokenIsValid(suppliedToken)) {
      logger.warn("System curtain control rejected", {
        requestId: req.requestId,
        ip: clientIp(req),
      });
      notFound(res);
      return;
    }
    const { json: body } = await readRequestBody(req);
    if (typeof body.active !== "boolean") {
      sendJson(res, 400, { ok: false, error: "Perde durumu true veya false olmalidir." });
      return;
    }
    const state = updateSystemCurtainState(body.active);
    logger.info("System curtain state changed", {
      requestId: req.requestId,
      ip: clientIp(req),
      active: state.active,
      updatedAt: state.updatedAt,
    });
    sendJson(res, 200, { ok: true, ...state });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/operation-map") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const packageRows = db.prepare(`
      SELECT restaurant_id,
        COUNT(*) AS active_count,
        SUM(CASE WHEN status IN (?, ?, ?, ?) THEN 1 ELSE 0 END) AS waiting_count,
        SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS assigned_count,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS route_count
      FROM packages
      WHERE status NOT IN (?, ?, ?, ?, ?)
      GROUP BY restaurant_id
    `).all(
      PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS,
      ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS,
      DELIVERED_STATUS, FAILED_STATUS, REJECTED_STATUS, CANCELED_STATUS, "canceled"
    );
    const countsByRestaurant = new Map(packageRows.map((row) => [row.restaurant_id, row]));
    const operationRestaurants = getRestaurants().map((restaurant) => {
      const counts = countsByRestaurant.get(restaurant.id) || {};
      return {
        ...sanitizeRestaurant(restaurant),
        activeCount: Number(counts.active_count || 0),
        waitingCount: Number(counts.waiting_count || 0),
        assignedCount: Number(counts.assigned_count || 0),
        routeCount: Number(counts.route_count || 0),
      };
    });
    const operationActiveLoadMap = buildActiveLoadMap(getPackages());
    const activeCouriers = liveMapCouriers(Date.now(), { includeBackground: true })
      .map((courier) => ({ ...sanitizeCourier(courier), activeLoad: operationActiveLoadMap.get(courier.id) || 0 }));

    sendJson(res, 200, { ok: true, restaurants: operationRestaurants, activeCouriers, generatedAt: nowIso() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/restaurants") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const pagination = paginationFromRequest(req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    sendJson(res, 200, {
      ok: true,
      restaurants: getRestaurants({ pagination }).map((restaurant) => sanitizeRestaurant(restaurant, true)),
      pagination: restaurantsPagination({}, pagination),
    });
    return;
  }

  const adminRestaurantCredentialsMatch = pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/credentials$/);
  if (req.method === "PATCH" && adminRestaurantCredentialsMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const restaurantId = decodeURIComponent(adminRestaurantCredentialsMatch[1]);
      const result = dbFacade.transaction(() => updateRestaurantCredentials(restaurantId, body));
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "restaurant_credentials_updated",
        restaurantId,
        details: {
          previousUsername: result.previousUsername,
          username: result.restaurant.username,
          passwordChanged: result.passwordChanged,
        },
      });
      broadcastLiveEvent({
        type: "restaurant-credentials-updated",
        restaurantId,
        message: `${result.restaurant.name} restoraninin giris bilgileri guncellendi.`,
      });
      sendJson(res, 200, {
        ok: true,
        passwordChanged: result.passwordChanged,
        restaurant: sanitizeRestaurant(result.restaurant, true),
        ...decorateState({ req }),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  const adminRestaurantLocationMatch = pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/location$/);
  if (req.method === "PUT" && adminRestaurantLocationMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const restaurantId = decodeURIComponent(adminRestaurantLocationMatch[1]);
      const { restaurant, previousLocation } = dbFacade.transaction(() => updateRestaurantLocation(restaurantId, body));
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "restaurant_location_updated",
        restaurantId: restaurant.id,
        details: {
          previousLocation,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
        },
      });
      scheduleRebalancePackages();
      broadcastLiveEvent({
        type: "restaurant-location-updated",
        restaurantId: restaurant.id,
        message: "Restoran konumu admin tarafindan guncellendi.",
      });
      sendJson(res, 200, {
        ok: true,
        restaurant: sanitizeRestaurant(restaurant, true),
        ...decorateState(),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  const adminRestaurantMatch = pathname.match(/^\/api\/admin\/restaurants\/([^/]+)$/);
  if (req.method === "PUT" && adminRestaurantMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const restaurant = updateRestaurantPlatformIds(adminRestaurantMatch[1], body);
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "restaurant_platform_ids_updated",
        restaurantId: restaurant.id,
        details: normalizeRestaurantPlatformIds(body),
      });
      sendJson(res, 200, { ok: true, restaurant: sanitizeRestaurant(restaurant, true), ...decorateState() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && adminRestaurantMatch) {
    sendJson(res, 405, { error: "Restoran silme bu sistemde mevcut akisi korumak icin kapali." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/orders") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pagination = paginationFromRequest(req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    const filter = {
      restaurantId: trimmed(requestUrl.searchParams.get("restaurantId")) || undefined,
      platform: trimmed(requestUrl.searchParams.get("platform")) || undefined,
      status: trimmed(requestUrl.searchParams.get("status")) || undefined,
      dateFrom: trimmed(requestUrl.searchParams.get("dateFrom")) || undefined,
      dateTo: trimmed(requestUrl.searchParams.get("dateTo")) || undefined,
      search: trimmed(requestUrl.searchParams.get("search")) || undefined,
      assignedOnly: requestUrl.searchParams.get("assignedOnly") === "true",
      pagination,
    };
    sendJson(res, 200, {
      ok: true,
      orders: getPackages(filter),
      pagination: packagePagination(filter, pagination),
    });
    return;
  }

  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (req.method === "GET" && adminOrderMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const order = getPackageById(adminOrderMatch[1]);
    sendJson(res, order ? 200 : 404, order ? { ok: true, order } : { error: "Siparis bulunamadi." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/unmatched-orders") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, { ok: true, unmatchedOrders: getUnmatchedOrders(200) });
    return;
  }

  const unmatchedMatch = pathname.match(/^\/api\/admin\/unmatched-orders\/([^/]+)\/match$/);
  if (req.method === "POST" && unmatchedMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const result = matchUnmatchedOrder(unmatchedMatch[1], trimmed(body.restaurantId || body.restaurant_id), {
        saveExternalId: body.saveExternalId !== false,
      });
      rebalancePackages();
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "unmatched_order_matched",
        packageId: result.packageId,
        restaurantId: result.restaurant.id,
        details: { unmatchedOrderId: unmatchedMatch[1], saveExternalId: body.saveExternalId !== false },
      });
      broadcastLiveEvent({
        type: "order:new",
        restaurantId: result.restaurant.id,
        message: "Eslestirilemeyen siparis restorana baglandi.",
        orderId: result.packageId,
      });
      sendJson(res, 200, { ok: true, result, ...decorateState() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/webhook-logs") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    sendJson(res, 200, {
      ok: true,
      webhookLogs: getWebhookLogs(200, { restaurantId: trimmed(requestUrl.searchParams.get("restaurantId")) || undefined }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/webhooks/test-order") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const order = normalizeWebhookOrderPayload(Object.keys(body || {}).length ? body : sampleWebhookPayload());
    const restaurant = findRestaurantByExternalRestaurantId(order.externalRestaurantId, order.platformSlug || order.platform);
    if (!restaurant) {
      const unmatchedId = upsertUnmatchedOrder(order);
      logPlatformRestaurantNotMatched(order, req);
      sendJson(res, 202, { ok: true, matched: false, unmatchedOrderId: unmatchedId, ...decorateState() });
      return;
    }
    const result = upsertWebhookPackage(order, restaurant, { requestId: req.requestId });
    resolveUnmatchedOrderForMatchedPackage(order, restaurant.id, result.packageId);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "admin_test_webhook_order_created",
      packageId: result.packageId,
      restaurantId: restaurant.id,
      details: { externalOrderId: order.externalOrderId, duplicate: result.duplicate },
    });
    broadcastLiveEvent({
      type: "order:new",
      restaurantId: restaurant.id,
      message: "Admin test webhook siparisi olusturuldu.",
      orderId: result.packageId,
      platform: order.platform,
    });
    sendJson(res, 200, { ok: true, matched: true, duplicate: result.duplicate, package: getPackageById(result.packageId), ...decorateState() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/stream") {
    const adminSession = getSessionFromQueryToken(req, "admin");
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    openLiveStream(req, res, { role: "admin", adminId: adminSession.admin_id });
    return;
  }

  const adminCourierEarningMatch = pathname.match(/^\/api\/admin\/courier-earnings\/([^/]+)$/);
  const adminCourierEarningPaidMatch = pathname.match(/^\/api\/admin\/courier-earnings\/([^/]+)\/mark-paid$/);

  if (req.method === "GET" && pathname === "/api/admin/courier-earnings") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      courierEarnings: getCourierEarnings({
        date: trimmed(url.searchParams.get("date")) || dayKey(),
        courierId: trimmed(url.searchParams.get("courierId")),
        restaurantId: trimmed(url.searchParams.get("restaurantId")),
        paymentStatus: trimmed(url.searchParams.get("paymentStatus")),
      }),
    });
    return;
  }

  if (req.method === "GET" && adminCourierEarningMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, courierEarning: getCourierEarningById(adminCourierEarningMatch[1]) });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/courier-earnings/generate") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const generated = generateCourierEarnings({
        date: trimmed(body.date) || dayKey(),
        courierId: trimmed(body.courierId),
        perPackageFee: body.perPackageFee,
        adminNote: body.adminNote,
      });
      sendJson(res, 200, { ok: true, courierEarnings: generated, state: decorateState({ req }) });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "PATCH" && adminCourierEarningMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const courierEarning = updateCourierEarning(adminCourierEarningMatch[1], body);
      sendJson(res, 200, { ok: true, courierEarning, state: decorateState({ req }) });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && adminCourierEarningPaidMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    try {
      const courierEarning = markCourierEarningPaid(adminCourierEarningPaidMatch[1], body);
      sendJson(res, 200, { ok: true, courierEarning, state: decorateState({ req }) });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "PUT" && pathname === "/api/admin/settings") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    updateSystemSettings(body);
    broadcastLiveEvent({ type: "system-settings-update", message: "Sistem ayarlari guncellendi." });
    sendJson(res, 200, { ok: true, state: decorateState() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    const auth = refreshSessionPair("admin", refreshToken, req);
    setSessionCookie(res, auth.token);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    const auth = refreshSessionPair("restaurant", refreshToken, req);
    setSessionCookie(res, auth.token);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    const auth = refreshSessionPair("courier", refreshToken, req);
    setSessionCookie(res, auth.token);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("admin_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("admin", hashOpaqueToken(refreshToken));
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/logout") {
    const session = getRestaurantSession(req);
    const { json: body } = await readRequestBody(req);
    if (session && body.pushEndpoint) {
      deleteRestaurantPushSubscription(session.restaurant_id, body.pushEndpoint);
    }
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("restaurant_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("restaurant", hashOpaqueToken(refreshToken));
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/logout") {
    const session = getCourierSession(req);
    if (session) {
      closeCourierShift(session.courier_id);
      broadcastLiveEvent({
        type: "courier-shift-ended",
        courierId: session.courier_id,
        message: "Kurye vardiyasi kapatildi.",
      });
    }
    const { json: body } = await readRequestBody(req);
    if (session && body.pushEndpoint) {
      deleteCourierPushSubscription(session.courier_id, body.pushEndpoint);
    }
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("courier_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("courier", hashOpaqueToken(refreshToken));
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/forgot-password") {
    const retryAfter = await applyRateLimit(req, "adminPasswordReset", RATE_LIMITS.passwordReset);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const startTime = Date.now();
    
    const actor = actorLookupByRole("admin", username);
    let token = null;
    
    if (actor) {
      token = issuePasswordReset("admin", actor.id, req);
      logPasswordReset("admin", username, token);
      writeAuditLog({
        actorRole: "admin",
        actorId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
    } else {
      // Timing attack mitigation: normalize response time for non-existent users
      const elapsed = Date.now() - startTime;
      const minDelay = 50;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    sendJson(res, 200, {
      message: "Parola yenileme talebi olusturuldu.",
      ...(NODE_ENV === "production" || !token ? {} : { resetToken: token }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/forgot-password") {
    const retryAfter = await applyRateLimit(req, "restaurantPasswordReset", RATE_LIMITS.passwordReset);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const startTime = Date.now();
    
    const actor = actorLookupByRole("restaurant", username);
    let token = null;
    
    if (actor) {
      token = issuePasswordReset("restaurant", actor.id, req);
      logPasswordReset("restaurant", username, token);
      writeAuditLog({
        actorRole: "restaurant",
        actorId: actor.id,
        restaurantId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
      sendJson(res, 200, {
        message: "Parola yenileme talebi olusturuldu.",
        ...(NODE_ENV === "production" || !token ? {} : { resetToken: token }),
      });
    } else {
      // Timing attack mitigation
      const elapsed = Date.now() - startTime;
      const minDelay = 50;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/forgot-password") {
    const retryAfter = await applyRateLimit(req, "courierPasswordReset", RATE_LIMITS.passwordReset);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const startTime = Date.now();
    
    const actor = actorLookupByRole("courier", username);
    let token = null;
    
    if (actor) {
      token = issuePasswordReset("courier", actor.id, req);
      logPasswordReset("courier", username, token);
      writeAuditLog({
        actorRole: "courier",
        actorId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
      sendJson(res, 200, {
        message: "Parola yenileme talebi olusturuldu.",
        ...(NODE_ENV === "production" || !token ? {} : { resetToken: token }),
      });
    } else {
      // Timing attack mitigation
      const elapsed = Date.now() - startTime;
      const minDelay = 50;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/reset-password") {
    const { json: body } = await readRequestBody(req);
    const { token, password } = validatePasswordResetDraft(body);
    const resetRow = consumePasswordReset("admin", token);
    updateActorPassword("admin", resetRow.actor_id, password);
    sendJson(res, 200, { message: "Admin parolasi guncellendi." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/reset-password") {
    const { json: body } = await readRequestBody(req);
    const { token, password } = validatePasswordResetDraft(body);
    const resetRow = consumePasswordReset("restaurant", token);
    updateActorPassword("restaurant", resetRow.actor_id, password);
    sendJson(res, 200, { message: "Restoran parolasi guncellendi." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/reset-password") {
    const { json: body } = await readRequestBody(req);
    const { token, password } = validatePasswordResetDraft(body);
    const resetRow = consumePasswordReset("courier", token);
    updateActorPassword("courier", resetRow.actor_id, password);
    sendJson(res, 200, { message: "Kurye parolasi guncellendi." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/session") {
    const retryAfter = await applyRateLimit(req, "restaurantLogin", RATE_LIMITS.restaurantLogin);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }

    const { json: body } = await readRequestBody(req);
    const access = validateRestaurantLoginDraft({
      ...body,
      headerRestaurantId: String(req.headers["x-restaurant-id"] || ""),
      headerApiKey: String(req.headers["x-api-key"] || ""),
    });
    const restaurant = access.mode === "portal"
      ? db.prepare("SELECT * FROM restaurants WHERE username = ?").get(access.username)
      : db.prepare("SELECT * FROM restaurants WHERE id = ? AND api_key = ?").get(access.restaurantId, access.apiKey);

    if (!restaurant) {
      sendJson(res, 401, { error: "Restoran kimligi veya API key hatali." });
      return;
    }

    // Validate password for portal mode
    if (access.mode === "portal") {
      if (!restaurant.password_salt || !verifyPassword(access.password, restaurant.password_salt, restaurant.password_hash)) {
        sendJson(res, 401, { error: "Restoran kimligi veya sifre hatali." });
        return;
      }
    }

    const auth = issueSessionPair("restaurant", restaurant.id, req);

    writeAuditLog({
      actorRole: "restaurant",
      actorId: restaurant.id,
      action: "restaurant_logged_in",
      restaurantId: restaurant.id,
      details: {
        mode: access.mode,
        username: restaurant.username || null,
      },
    });

    setSessionCookie(res, auth.token);
    sendJson(res, 200, {
      ...auth,
      state: decorateState({
        restaurantId: restaurant.id,
        includeRestaurantSecrets: true,
        req,
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/bootstrap") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    sendJson(res, 200, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
      req,
    }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/orders") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const pagination = paginationFromRequest(req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    const filter = { restaurantId: session.restaurant_id, pagination };
    sendJson(res, 200, {
      ok: true,
      orders: getPackages(filter),
      pagination: packagePagination(filter, pagination),
    });
    return;
  }

  const restaurantOrderMatch = pathname.match(/^\/api\/restaurant\/orders\/([^/]+)$/);
  if (req.method === "GET" && restaurantOrderMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const order = getPackageById(restaurantOrderMatch[1]);
    if (!order || order.restaurantId !== session.restaurant_id) {
      sendJson(res, 404, { error: "Siparis bulunamadi." });
      return;
    }
    sendJson(res, 200, { ok: true, order });
    return;
  }

  const restaurantOrderStatusMatch = pathname.match(/^\/api\/restaurant\/orders\/([^/]+)\/status$/);
  if (req.method === "PUT" && restaurantOrderStatusMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND restaurant_id = ?").get(restaurantOrderStatusMatch[1], session.restaurant_id);
    if (!target) {
      sendJson(res, 404, { error: "Siparis bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const nextStatus = normalizeStatus(body.status);
    updatePackageLifecycle(target.id, { status: nextStatus }, mapPackageRow(target));
    updatePlatformOrderStatusByPackage(getPackageById(target.id), nextStatus);
    broadcastLiveEvent({
      type: "order:status",
      restaurantId: session.restaurant_id,
      message: "Siparis durumu guncellendi.",
      orderId: target.id,
      status: nextStatus,
    });
    sendJson(res, 200, decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, req }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/reports/account") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const requestedDate = trimmed(requestUrl.searchParams.get("date")) || restaurantReportDayKey();
    const period = trimmed(requestUrl.searchParams.get("period")).toLowerCase() || "day";
    const statusFilter = trimmed(requestUrl.searchParams.get("status")).toLowerCase() || "all";
    const paymentFilter = trimmed(requestUrl.searchParams.get("payment")).toLowerCase() || "all";
    const validStatuses = new Set(["all", "delivered", "cancelled", "active", "failed"]);
    const validPayments = new Set(["all", "cash", "card", "online", "restaurant", "other"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !["day", "week"].includes(period) || !validStatuses.has(statusFilter) || !validPayments.has(paymentFilter)) {
      sendJson(res, 400, { error: "Gecersiz rapor filtresi." });
      return;
    }
    sendJson(res, 200, buildAccountOrderReport({
      restaurantId: session.restaurant_id,
      requestedDate,
      period,
      statusFilter,
      paymentFilter,
    }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/reports/daily") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const isPostgres = dbFacade.clientName() === "postgres";
    const reportDateExpr = isPostgres
      ? "TO_CHAR(COALESCE(NULLIF(delivered_at::text, '')::timestamp, NULLIF(updated_at::text, '')::timestamp, NULLIF(created_at::text, '')::timestamp), 'YYYY-MM-DD')"
      : "DATE(COALESCE(delivered_at, updated_at, created_at), 'localtime')";
    const sql = `
      SELECT 
        ${reportDateExpr} as date,
        id,
        tracking_no,
        COALESCE(assigned_courier_name, 'Bilinmiyor') as courier_name,
        order_amount,
        payment_method,
        payment_status
      FROM packages
      WHERE restaurant_id = ? 
        AND status = 'delivered'
      ORDER BY date DESC, courier_name ASC
    `;
    const packageRows = db.prepare(sql).all(session.restaurant_id);
    const seenPackages = new Set();
    const reportMap = new Map();
    for (const pkg of packageRows) {
      const uniqueKey = pkg.id || pkg.tracking_no;
      if (!uniqueKey || seenPackages.has(uniqueKey)) continue;
      seenPackages.add(uniqueKey);

      const date = pkg.date || "";
      const courierName = pkg.courier_name || "Bilinmiyor";
      const mapKey = `${date}::${courierName}`;
      if (!reportMap.has(mapKey)) {
        reportMap.set(mapKey, {
          date,
          courier_name: courierName,
          package_count: 0,
          cash_revenue: 0,
          card_revenue: 0,
          online_revenue: 0,
          total_revenue: 0,
        });
      }
      const row = reportMap.get(mapKey);
      const amount = normalizeMoney(pkg.order_amount);
      const paymentText = `${pkg.payment_method || ""} ${pkg.payment_status || ""}`.toLowerCase();
      row.package_count += 1;
      row.total_revenue = normalizeMoney(row.total_revenue + amount);
      if (paymentText.includes("cash") || paymentText.includes("nakit")) {
        row.cash_revenue = normalizeMoney(row.cash_revenue + amount);
      } else if (paymentText.includes("card") || paymentText.includes("kart") || paymentText.includes("kredi")) {
        row.card_revenue = normalizeMoney(row.card_revenue + amount);
      } else {
        row.online_revenue = normalizeMoney(row.online_revenue + amount);
      }
    }
    const rows = Array.from(reportMap.values()).sort((a, b) => (
      String(b.date).localeCompare(String(a.date)) || String(a.courier_name).localeCompare(String(b.courier_name), "tr")
    ));
    sendJson(res, 200, { ok: true, reports: rows });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/reports/daily-detail") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const dateParam = requestUrl.searchParams.get("date");
    const courierParam = requestUrl.searchParams.get("courier");
    if (!dateParam) {
      sendJson(res, 400, { error: "Tarih parametresi gereklidir. Örnek: ?date=2026-06-19" });
      return;
    }

    // Belirtilen güne ait teslim edilen tüm paketleri getir
    const isPostgres = dbFacade.clientName() === "postgres";
    const reportDateExpr = isPostgres
      ? "TO_CHAR(COALESCE(NULLIF(delivered_at::text, '')::timestamp, NULLIF(updated_at::text, '')::timestamp, NULLIF(created_at::text, '')::timestamp), 'YYYY-MM-DD')"
      : "DATE(COALESCE(delivered_at, updated_at, created_at), 'localtime')";
    const whereParts = [
      "restaurant_id = ?",
      "status = 'delivered'",
      `${reportDateExpr} = ?`,
    ];
    const params = [session.restaurant_id, dateParam];
    if (courierParam) {
      whereParts.push("COALESCE(assigned_courier_name, 'Bilinmiyor') = ?");
      params.push(courierParam);
    }

    const detailSql = `
      SELECT
        id, tracking_no, recipient, phone, address, delivery_address, customer_address,
        assigned_courier_name,
        payment_method, order_amount, payment_status,
        source_platform, external_order_no,
        created_at, updated_at, delivered_at,
        distance_km,
        note, customer_note, status
      FROM packages
      WHERE ${whereParts.join("\n        AND ")}
      ORDER BY COALESCE(delivered_at, updated_at, created_at) ASC
    `;
    const rawPackages = db.prepare(detailSql).all(...params);
    const seenDetailPackages = new Set();
    const packages = [];
    for (const pkg of rawPackages) {
      const uniqueKey = pkg.id || pkg.tracking_no;
      if (!uniqueKey || seenDetailPackages.has(uniqueKey)) continue;
      seenDetailPackages.add(uniqueKey);
      packages.push({ ...pkg, order_amount: normalizeMoney(pkg.order_amount) });
    }

    for (const pkg of packages) {
      pkg.audit_history = db.prepare(`
        SELECT action, details_json, created_at
        FROM audit_logs
        WHERE package_id = ?
        ORDER BY id ASC
        LIMIT 6
      `).all(pkg.id);
    }

    // Özet hesapla
    let total_revenue = 0;
    let cash_revenue = 0;
    let card_revenue = 0;
    let online_revenue = 0;
    const courierMap = {};

    for (const pkg of packages) {
      const amt = normalizeMoney(pkg.order_amount);
      total_revenue += amt;
      const paymentText = `${pkg.payment_method || ""} ${pkg.payment_status || ""}`.toLowerCase();

      if (paymentText.includes("cash") || paymentText.includes("nakit")) {
        cash_revenue += amt;
      } else if (paymentText.includes("card") || paymentText.includes("kart") || paymentText.includes("kredi")) {
        card_revenue += amt;
      } else {
        online_revenue += amt;
      }

      const courierName = pkg.assigned_courier_name || "Bilinmiyor";
      if (!courierMap[courierName]) {
        courierMap[courierName] = { name: courierName, package_count: 0, total_revenue: 0 };
      }
      courierMap[courierName].package_count += 1;
      courierMap[courierName].total_revenue = normalizeMoney(courierMap[courierName].total_revenue + amt);
    }

    const couriers = Object.values(courierMap).sort((a, b) => b.package_count - a.package_count);

    sendJson(res, 200, {
      ok: true,
      date: dateParam,
      summary: {
        total_packages: packages.length,
        total_revenue: normalizeMoney(total_revenue),
        cash_revenue: normalizeMoney(cash_revenue),
        card_revenue: normalizeMoney(card_revenue),
        online_revenue: normalizeMoney(online_revenue)
      },
      couriers,
      packages
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/stream") {
    const session = getSessionFromQueryToken(req, "restaurant");
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    openLiveStream(req, res, { role: "restaurant", restaurantId: session.restaurant_id });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/platform-accounts") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      platformAccounts: getPlatformAccounts({ restaurantId: session.restaurant_id })
        .map((account) => sanitizePlatformAccount(account, true)),
    });
    return;
  }

  const restaurantPlatformHealthMatch = pathname.match(/^\/api\/restaurant\/platform-accounts\/([^/]+)\/health$/);
  if (req.method === "GET" && restaurantPlatformHealthMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === restaurantPlatformHealthMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      account: sanitizePlatformAccount(account, true),
      health: buildHealthPayload(account),
      recentEvents: getPlatformEvents(5, { platformAccountId: account.id }).map((event) => ({
        eventType: event.eventType,
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
      })),
    });
    return;
  }

  const restaurantPlatformCheckMatch = pathname.match(/^\/api\/restaurant\/platform-accounts\/([^/]+)\/check-connection$/);
  if (req.method === "POST" && restaurantPlatformCheckMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === restaurantPlatformCheckMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await checkPlatformAccountConnection(account, req);
    sendJson(res, 200, {
      ok: true,
      account: result.account,
      health: result.account.connectionHealth,
      publicMessage: result.account.connectionHealth.publicMessage,
      recentEvents: result.recentEvents.slice(0, 5),
    });
    return;
  }

  const restaurantCustomersMatch = pathname.match(/^\/api\/restaurants\/([^/]+)\/customers(?:\/search)?$/);
  const restaurantCustomerItemMatch = pathname.match(/^\/api\/customers\/([^/]+)$/);

  if (req.method === "GET" && (pathname === "/api/restaurant/customers" || restaurantCustomersMatch)) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    if (restaurantCustomersMatch && restaurantCustomersMatch[1] !== session.restaurant_id) {
      sendJson(res, 403, { error: "Bu restoranin musterilerine erisim yetkin yok." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      customers: getRestaurantCustomers(session.restaurant_id, url.searchParams.get("phone") || url.searchParams.get("search") || ""),
    });
    return;
  }

  if (req.method === "POST" && (pathname === "/api/restaurant/customers" || restaurantCustomersMatch)) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    if (restaurantCustomersMatch && restaurantCustomersMatch[1] !== session.restaurant_id) {
      sendJson(res, 403, { error: "Bu restoran icin musteri ekleme yetkin yok." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const customer = upsertRestaurantCustomer(session.restaurant_id, body);
    if (!customer?.id) {
      sendJson(res, 400, { error: "Telefon numarasi zorunludur." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      customer,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, req }),
    });
    return;
  }

  if ((req.method === "PATCH" || req.method === "DELETE") && restaurantCustomerItemMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    try {
      if (req.method === "DELETE") {
        softDeleteRestaurantCustomer(restaurantCustomerItemMatch[1], session.restaurant_id);
        sendJson(res, 200, {
          ok: true,
          customers: getRestaurantCustomers(session.restaurant_id),
          state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, req }),
        });
        return;
      }
      const { json: body } = await readRequestBody(req);
      const customer = updateRestaurantCustomer(restaurantCustomerItemMatch[1], session.restaurant_id, body);
      sendJson(res, 200, {
        ok: true,
        customer,
        customers: getRestaurantCustomers(session.restaurant_id),
        state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, req }),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Platform entegrasyon limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const draft = validatePlatformAccountDraft({
      ...body,
      restaurantId: body.restaurantId || body.restaurant_id || session.restaurant_id,
    });

    if (draft.restaurantId !== session.restaurant_id) {
      sendJson(res, 403, { error: "Bu restoran baska tenant icin entegrasyon kaydedemez." });
      return;
    }

    const now = new Date().toISOString();
    const draftConfig = platformConfig(draft.platform);
    const verification = {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      note: "Webhook modu aktif. Polling API kapalı — webhook ile sipariş bekleniyor.",
      mode: `${draftConfig.mode}_auto`,
    };
    verification.note = `${draft.platform} entegrasyonu ${draftConfig.mode} modunda kaydedildi. Ilk gercek siparis bekleniyor.`;
    db.prepare("UPDATE restaurants SET webhook_secret = ? WHERE id = ?").run(draft.webhookSecret, session.restaurant_id);
    const existing = db.prepare(`
      SELECT * FROM platform_accounts
      WHERE restaurant_id = ? AND platform = ? AND external_store_id = ?
    `).get(session.restaurant_id, draft.platform, draft.externalStoreId);

    if (existing) {
      db.prepare(`
        UPDATE platform_accounts
        SET external_id = ?, external_merchant_id = ?, api_username = ?, api_password = ?, api_key = ?, api_secret = ?, token = ?,
            store_front_code = ?, chain_id = ?, vendor_id = ?, webhook_auth_type = ?, webhook_api_key = ?,
            webhook_username = ?, webhook_password = ?, static_token = ?, access_token = ?, refresh_token = ?, token_expires_at = ?,
            callback_url = ?, auth_type = ?, webhook_secret = ?, integration_reference_code = ?, pos_secret_key = ?,
            is_active = ?, settings_json = ?, verification_status = ?, verification_note = ?, last_verification_at = ?,
            verified_at = ?, last_validation_mode = ?, active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        draft.externalId || draft.externalStoreId,
        draft.externalMerchantId || null,
        draft.apiUsername || null,
        draft.apiPassword || null,
        draft.apiKey || null,
        draft.apiSecret || null,
        draft.token || null,
        draft.storeFrontCode || null,
        draft.chainId || null,
        draft.vendorId || null,
        PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
        null,
        null,
        null,
        draft.webhookSecret,
        draft.accessToken || null,
        draft.refreshToken || null,
        draft.tokenExpiresAt || null,
        draft.callbackUrl || null,
        draft.authType,
        draft.webhookSecret,
        draft.integrationReferenceCode || null,
        draft.posSecretKey || null,
        draft.active ? 1 : 0,
        json(draft.settings),
        verification.status,
        verification.note,
        now,
        verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
        verification.mode,
        draft.active ? 1 : 0,
        now,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO platform_accounts (
          id, restaurant_id, platform, external_id, external_store_id, external_merchant_id, api_username, api_password,
          api_key, api_secret, token, store_front_code, chain_id, vendor_id, webhook_auth_type, webhook_api_key,
          webhook_username, webhook_password, static_token, access_token, refresh_token, token_expires_at,
          callback_url, auth_type, webhook_secret, integration_reference_code, pos_secret_key, is_active, webhook_id,
          settings_json, verification_status, verification_note, last_verification_at, verified_at, last_validation_mode,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uid("pla"),
        session.restaurant_id,
        draft.platform,
        draft.externalId || draft.externalStoreId,
        draft.externalStoreId,
        draft.externalMerchantId || null,
        draft.apiUsername || null,
        draft.apiPassword || null,
        draft.apiKey || null,
        draft.apiSecret || null,
        draft.token || null,
        draft.storeFrontCode || null,
        draft.chainId || null,
        draft.vendorId || null,
        PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
        null,
        null,
        null,
        draft.webhookSecret,
        draft.accessToken || null,
        draft.refreshToken || null,
        draft.tokenExpiresAt || null,
        draft.callbackUrl || null,
        draft.authType,
        draft.webhookSecret,
        draft.integrationReferenceCode || null,
        draft.posSecretKey || null,
        draft.active ? 1 : 0,
        null,
        json(draft.settings),
        verification.status,
        verification.note,
        now,
        verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
        verification.mode,
        draft.active ? 1 : 0,
        now,
        now
      );
    }

    db.prepare(`
      UPDATE platform_accounts
      SET integration_ref_code = ?,
          integration_reference_code = ?,
          polling_enabled = ?,
          webhook_enabled = ?,
          active = ?,
          is_active = ?,
          connection_status = ?,
          last_check_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          consecutive_failures = 0,
          last_error = NULL,
          updated_at = ?
      WHERE restaurant_id = ? AND platform = ? AND external_store_id = ?
    `).run(
      draft.integrationReferenceCode || null,
      draft.integrationReferenceCode || null,
      draft.pollingEnabled ? 1 : 0,
      draft.webhookEnabled ? 1 : 0,
      draft.active ? 1 : 0,
      draft.active ? 1 : 0,
      draft.active ? HEALTH_STATUS.UNKNOWN : HEALTH_STATUS.DISABLED,
      now,
      session.restaurant_id,
      draft.platform,
      draft.externalStoreId
    );

    writeAuditLog({
      actorRole: "restaurant",
      actorId: session.restaurant_id,
      action: "platform_account_saved",
      restaurantId: session.restaurant_id,
      details: {
        platform: draft.platform,
        externalStoreId: draft.externalStoreId,
        verificationStatus: verification.status,
      },
    });
    logger.info("Platform account saved", {
      restaurantId: session.restaurant_id,
      platform: draft.platform,
      externalStoreId: draft.externalStoreId,
      active: draft.active,
      webhookEnabled: draft.webhookEnabled,
      pollingEnabled: draft.pollingEnabled,
      secretConfigured: Boolean(draft.webhookSecret),
      mode: "webhook",
    });
    platformService?.savePlatformAccount({
      ...draft,
      restaurantId: session.restaurant_id,
    });
    broadcastLiveEvent({
      type: "platform-account-saved",
      restaurantId: session.restaurant_id,
      message: `${draft.platform} platform hesabi kaydedildi.`,
    });

    sendJson(res, 200, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
      includePlatformSecrets: true,
      req,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts/test") {
    if (IS_PRODUCTION) {
      productionDisabled(res);
      return;
    }
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const accountId = trimmed(body.accountId || body.account_id);
    if (!accountId) {
      sendJson(res, 400, { error: "accountId zorunludur." });
      return;
    }

    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === accountId);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }

    const result = handleSimplePlatformOrder({
      platform: account.platform,
      platformRestaurantId: account.externalStoreId,
      orderId: `TEST-${Date.now()}`,
      customerName: "Test Musteri",
      phone: "05555555555",
      address: "Mersin Test Adresi",
      totalPrice: 250,
      paymentMethod: "Online Odeme",
      customerNote: "Restoran panel test siparisi",
      items: [{ id: "test-1", name: "Test Burger", quantity: 1, price: 250 }],
    }, false, { requestId: req.requestId });
    if (!result.ok) {
      sendJson(res, result.statusCode || 404, { ok: false, error: result.error });
      return;
    }

    broadcastLiveEvent({
      type: "platform-test",
      restaurantId: session.restaurant_id,
      message: `${account.platform} test siparisi olusturuldu.`,
    });
    sendJson(res, 200, {
      verification: {
        status: "verified",
        note: "Test platform siparisi olusturuldu.",
      },
      package: result.package,
      state: decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        includePlatformSecrets: true,
        req,
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts/test-connection") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === trimmed(body.accountId || body.account_id));
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const restaurant = getRestaurants({ restaurantId: session.restaurant_id })[0];
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }
    const result = await testPlatformAccountAutomatically(account);
    logPlatformConnectionTest(account, result);
    const verificationStatus = result.ok
      ? PLATFORM_VERIFICATION_STATUS.VERIFIED
      : (result.optional || result.manualAvailable)
        ? PLATFORM_VERIFICATION_STATUS.PENDING
        : PLATFORM_VERIFICATION_STATUS.FAILED;
    markPlatformAccountVerification(account.id, {
      status: verificationStatus,
      mode: result.strategy || testStrategyForAccount(account),
      note: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
    });
    sendJson(res, platformConnectionHttpStatus(result), {
      ok: result.ok,
      status: result.status,
      strategy: result.strategy || testStrategyForAccount(account),
      message: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
      error: result.ok ? undefined : platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
      verification: {
        status: verificationStatus,
        note: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
      },
      package: result.package,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  const restaurantPollTestMatch = pathname.match(/^\/api\/restaurant\/platform-accounts\/([^/]+)\/poll-test$/);
  if (req.method === "POST" && restaurantPollTestMatch) {
    if (IS_PRODUCTION) {
      productionDisabled(res);
      return;
    }
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const accountId = decodeURIComponent(restaurantPollTestMatch[1]);
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === accountId);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await platformService.pollPlatformAccount(account, { manual: true });
    const message = !account.pollingEnabled
      ? "Polling kapalı"
      : platformAccountMissingCredentials(account)
        ? "API bilgileri eksik"
        : result.reason || `${result.fetchedCount || 0} sipariş bulundu`;
    sendJson(res, 200, {
      ok: Boolean(result.ok),
      message: result.ok
        ? `${result.fetchedCount || 0} sipariş bulundu${result.trackingNumbers?.length ? `. Paketler: ${result.trackingNumbers.join(", ")}` : ""}`
        : message,
      result,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts/sync") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === trimmed(body.accountId || body.account_id));
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await platformService.pollPlatformAccount(account, { manual: true });
    sendJson(res, result.ok || result.optional || result.skipped ? 200 : 400, {
      ok: result.ok,
      error: result.ok ? undefined : result.reason,
      message: result.ok
        ? `${result.fetchedCount || 0} sipariş bulundu${result.trackingNumbers?.length ? `. Paketler: ${result.trackingNumbers.join(", ")}` : ""}`
        : result.reason,
      result,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-orders/manual") {
    traceCreateEndpoint("ENTER_PLATFORM_ORDER_ENDPOINT", req, pathname, { originalPath: originalPathname });
    const session = getRestaurantSession(req);
    if (!session) {
      logInsertSkipped("platform_orders", "missing_restaurant_session", req);
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const restaurant = getRestaurants({ restaurantId: session.restaurant_id })[0];
    if (!restaurant) {
      logInsertSkipped("platform_orders", "restaurant_not_found", req, { restaurantId: session.restaurant_id });
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }
    const platform = normalizePlatformInput(body.platform) || "POS";
    const externalStoreId = trimmed(body.platformRestaurantId || body.externalStoreId) ||
      getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.platform === platform)?.externalStoreId ||
      `manual-${session.restaurant_id}`;
    const order = normalizeOrder(platform, {
      platform,
      platformRestaurantId: externalStoreId,
      orderId: trimmed(body.orderId) || `MANUAL-${Date.now()}`,
      customerName: body.customerName,
      phone: body.phone,
      address: body.address,
      totalPrice: body.totalPrice,
      paymentMethod: body.paymentMethod || "Panel Kaydi",
      customerNote: body.note,
      rawPayload: body,
    });
    let account = findPlatformRestaurant(platform, externalStoreId);
    if (!account) {
      const platformOrderId = upsertPlatformOrderRecord(order, restaurant.id, "accepted", { requestId: req.requestId });
      const payload = createSimplePlatformPayload(order, restaurant);
      payload.status = AWAITING_ASSIGNMENT_STATUS;
      payload.assignmentStatus = "unassigned";
      payload.assignmentReason = "Manuel platform siparisi onaylanarak havuza alindi.";
      
      const created = upsertPlatformPackage(platform, restaurant, payload, { requestId: req.requestId });
      if (created?.id) {
        rebalancePackages();
        broadcastLiveEvent({
          type: "platform-order-pending",
          restaurantId: restaurant.id,
          packageId: created.id,
          source: "platform_manual",
          suppressRestaurantAlert: true,
          message: "Manuel platform siparisi kurye atama havuzuna alindi.",
        });
      }
      logAfterCommit("platform_orders", platformOrderId, req.requestId);
      selectInsertedRowOrThrow("platform_orders", platformOrderId, req.requestId);
      if (created?.id) {
        logAfterCommit("packages", created.id, req.requestId);
        selectInsertedRowOrThrow("packages", created.id, req.requestId);
      }
      sendJson(res, 201, {
        ok: true,
        package: created,
        platformOrder: getPlatformOrderById(platformOrderId),
        state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
      });
      return;
    }
    const result = handleSimplePlatformOrder(order, true, { requestId: req.requestId });
    if (result.platformOrder?.id) {
      logAfterCommit("platform_orders", result.platformOrder.id, req.requestId);
      selectInsertedRowOrThrow("platform_orders", result.platformOrder.id, req.requestId);
    }
    if (result.package?.id) {
      logAfterCommit("packages", result.package.id, req.requestId);
      selectInsertedRowOrThrow("packages", result.package.id, req.requestId);
    }
    sendJson(res, 201, {
      ok: true,
      package: result.package,
      platformOrder: result.platformOrder || null,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/packages") {
    traceCreateEndpoint("ENTER_PACKAGE_ENDPOINT", req, pathname, { originalPath: originalPathname });
    const session = getRestaurantSession(req);
    if (!session) {
      logInsertSkipped("packages", "missing_restaurant_session", req);
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      logInsertSkipped("packages", "rate_limited", req, { retryAfter });
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Paket olusturma limiti asildi." });
      return;
    }

    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(session.restaurant_id);
    if (!restaurantRow) {
      logInsertSkipped("packages", "restaurant_not_found", req, { restaurantId: session.restaurant_id });
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const bodyRestaurantId = trimmed(body.restaurant_id ?? body.restaurantId);
    if (bodyRestaurantId && bodyRestaurantId !== session.restaurant_id) {
      logger.warn("PACKAGE_BODY_RESTAURANT_ID_IGNORED", {
        requestId: req.requestId,
        bodyRestaurantId,
        sessionRestaurantId: session.restaurant_id,
      });
    }
    const draft = {
      restaurantId: session.restaurant_id,
      deliveryAddress: trimmed(body.delivery_address ?? body.deliveryAddress),
      packageType: trimmed(body.package_type ?? body.packageType),
      orderAmount: normalizeMoney(body.order_amount ?? body.orderAmount),
      customerName: trimmed(body.customer_name ?? body.customerName),
      phone: trimmed(body.phone),
      customerAddress: trimmed(body.customer_address ?? body.customerAddress ?? body.delivery_address ?? body.deliveryAddress),
      paymentMethod: trimmed(body.payment_method ?? body.paymentMethod) || "paid_online",
      paymentStatus: trimmed(body.payment_status ?? body.paymentStatus),
      restaurantCustomerId: trimmed(body.restaurantCustomerId ?? body.restaurant_customer_id),
      customerNote: trimmed(body.customer_note ?? body.customerNote),
      source: trimmed(body.source),
      sourcePlatform: trimmed(body.source_platform ?? body.sourcePlatform),
      rawText: trimmed(body.raw_text ?? body.rawText),
      requestedStatus: trimmed(body.status),
    };
    const paymentDraft = validatePaymentDraft(draft);
    if (paymentDraft.error) {
      logInsertSkipped("packages", "payment_validation_failed", req, { error: paymentDraft.error });
      sendJson(res, 400, { error: paymentDraft.error });
      return;
    }
    draft.paymentMethod = PAYMENT_METHOD_LABELS[paymentDraft.methodCode];
    draft.paymentStatus = paymentDraft.paymentStatus;
    const errors = validatePackageDraft(draft);

    if (errors.length > 0) {
      logInsertSkipped("packages", "validation_failed", req, { errors });
      sendJson(res, 400, { error: errors.join(" ") });
      return;
    }

    const canCreateCustomer = normalizePhone(draft.phone) && trimmed(draft.customerName) && trimmed(draft.customerAddress || draft.deliveryAddress);
    const customer = draft.restaurantCustomerId
      ? db.prepare("SELECT * FROM customers WHERE id = ? AND restaurant_id = ?").get(draft.restaurantCustomerId, session.restaurant_id)
      : (canCreateCustomer ? upsertRestaurantCustomer(session.restaurant_id, {
        name: draft.customerName,
        phone: draft.phone,
        address: draft.customerAddress || draft.deliveryAddress,
      }) : null);
    if (draft.restaurantCustomerId && !customer) {
      sendJson(res, 400, { error: "Secilen musteri bu restorana ait degil." });
      return;
    }
    if (customer) {
      draft.restaurantCustomerId = customer.id;
      draft.customerName = draft.customerName || customer.name;
      draft.phone = normalizePhone(draft.phone) || customer.phone;
      draft.customerAddress = draft.customerAddress || customer.address;
      draft.deliveryAddress = draft.deliveryAddress || customer.address;
    }

    const pkg = buildRestaurantPackageRecord(restaurantRow, draft);
    
    if (body.photoBase64) {
      try {
        const base64Data = body.photoBase64.replace(/^data:image\/\w+;base64,/, "");
        const fileName = `photo_${pkg.trackingNo}.jpg`;
        const filePath = path.resolve(__dirname, "uploads", fileName);
        fs.writeFileSync(filePath, base64Data, "base64");
        pkg.rawPayload = pkg.rawPayload || {};
        pkg.rawPayload.photoUrl = `/uploads/${fileName}`;
      } catch (err) {
        logger.error("Failed to save photoBase64", err);
      }
    }

    dbFacade.transaction(() => {
      createPackageRecord(pkg, pkg.packageType, { requestId: req.requestId });
      touchRestaurantCustomerOrder(pkg.restaurantCustomerId, session.restaurant_id, pkg.createdAt);
      assertPersistedRecord("packages", pkg.id, "package_created", req.requestId);
      writeAuditLog({
        actorRole: "restaurant",
        actorId: session.restaurant_id,
        action: "package_created_manual",
        packageId: pkg.id,
        restaurantId: session.restaurant_id,
        details: {
          externalOrderNo: pkg.externalOrderNo,
          packageType: pkg.packageType,
          orderAmount: pkg.orderAmount,
        },
      });
    });
    logAfterCommit("packages", pkg.id, req.requestId);
    selectInsertedRowOrThrow("packages", pkg.id, req.requestId);
    rebalancePackages();
    broadcastLiveEvent({
      type: "package-created",
      restaurantId: session.restaurant_id,
      packageId: pkg.id,
      source: pkg.source || "external_manual",
      suppressRestaurantAlert: true,
      message: "Manuel paket operasyon havuzuna alindi.",
    });
    sendJson(res, 201, {
      ...decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
      req,
      }),
      createdPackage: getPackageById(pkg.id),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/packages/quick-paste") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "quickPaste", RATE_LIMITS.quickPaste);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }

    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(session.restaurant_id);
    if (!restaurantRow) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const rawText = normalizeQuickPasteText(body.rawText ?? body.raw_text);
    if (!rawText) {
      sendJson(res, 400, { error: "rawText zorunludur." });
      return;
    }

    const parsed = parseQuickPasteText(rawText);
    const draft = {
      restaurantId: session.restaurant_id,
      deliveryAddress: parsed.customerAddress,
      packageType: parsed.packageType,
      orderAmount: normalizeMoney(parsed.orderAmount),
      customerName: parsed.customerName,
      phone: parsed.phone,
      customerAddress: parsed.customerAddress,
      paymentMethod: parsed.paymentMethod || "Panel Kaydi",
      customerNote: parsed.customerNote,
      source: trimmed(body.source) || "platform_extension",
      sourcePlatform: trimmed(body.sourcePlatform ?? body.source_platform) || parsed.platform || "Diger",
      rawText,
      requestedStatus: AWAITING_ASSIGNMENT_STATUS,
    };
    const dedupeKey = trimmed(body.dedupeKey ?? body.dedupe_key);

    const errors = validatePackageDraft(draft);
    if (errors.length > 0) {
      sendJson(res, 400, {
        error: errors.join(" "),
        parsed,
      });
      return;
    }

    const duplicate = findDuplicatePackage(session.restaurant_id, draft.source, dedupeKey);
    if (duplicate) {
      sendJson(res, 200, {
        ok: true,
        package: decorateState({ restaurantId: session.restaurant_id }).packages.find((item) => item.id === duplicate.id) || getPackageById(duplicate.id),
        parsed,
        duplicate: true,
        state: decorateState({
          restaurantId: session.restaurant_id,
          includeRestaurantSecrets: true,
          req,
        }),
      });
      return;
    }

    const pkg = buildRestaurantPackageRecord(restaurantRow, draft, {
      externalOrderId: dedupeKey || undefined,
    });
    
    if (body.photoBase64) {
      try {
        const base64Data = body.photoBase64.replace(/^data:image\/\w+;base64,/, "");
        const fileName = `photo_${pkg.trackingNo}.jpg`;
        const filePath = path.resolve(__dirname, "uploads", fileName);
        fs.writeFileSync(filePath, base64Data, "base64");
        pkg.rawPayload = pkg.rawPayload || {};
        pkg.rawPayload.photoUrl = `/uploads/${fileName}`;
      } catch (err) {
        logger.error("Failed to save photoBase64 in quick-paste", err);
      }
    }

    createPackageRecord(pkg, pkg.packageType, { requestId: req.requestId });
    touchRestaurantCustomerOrder(pkg.restaurantCustomerId, session.restaurant_id, pkg.createdAt);
    assertPersistedRecord("packages", pkg.id, "package_created", req.requestId);
    rebalancePackages();

    writeAuditLog({
      actorRole: "restaurant",
      actorId: session.restaurant_id,
      action: "package_created_quick_paste_extension",
      packageId: pkg.id,
      restaurantId: session.restaurant_id,
      details: {
        externalOrderNo: pkg.externalOrderNo,
        sourcePlatform: pkg.sourcePlatform,
      },
    });
    broadcastLiveEvent({
      type: "package-created",
      restaurantId: session.restaurant_id,
      packageId: pkg.id,
      message: `${pkg.sourcePlatform} uzantisindan hizli siparis alindi.`,
    });

    sendJson(res, 201, {
      ok: true,
      package: getPackageById(pkg.id),
      parsed,
      state: decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }),
    });
    return;
  }

  const restaurantPackageActionMatch = pathname.match(/^\/api\/restaurant\/packages\/([^/]+)\/action$/);
  if (req.method === "POST" && restaurantPackageActionMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const action = trimmed(body.action).toLowerCase();
    const packageId = restaurantPackageActionMatch[1];
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND restaurant_id = ?").get(packageId, session.restaurant_id);

    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const source = normalizeOrderSource(target.source, target.source_platform);
    const isPlatformBackedOrder = source !== "external_manual" && source !== "manual";

    const targetStatus = normalizeStatus(target.status);
    if (action === "reject" && targetStatus !== PENDING_APPROVAL_STATUS) {
      sendJson(res, 409, {
        error: "Yalnizca onay bekleyen platform siparisleri reddedilebilir.",
        currentStatus: targetStatus,
      });
      return;
    }

    if (action === "confirm" && targetStatus !== PENDING_APPROVAL_STATUS) {
      if ([REJECTED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, FAILED_STATUS, CANCELED_STATUS].includes(targetStatus)) {
        sendJson(res, 409, {
          error: "Bu durumdaki siparis onaylanamaz.",
          currentStatus: targetStatus,
        });
        return;
      }
      // Entegrasyonlar ayni onayi tekrar gonderebilir. Aktif sipariste onayi
      // idempotent tutarak mevcut kurye atamasini ve operasyon durumunu koru.
      sendJson(res, 200, decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }));
      return;
    }

    if (action === "confirm") {
      db.prepare(`
        UPDATE packages
        SET status = ?, assignment_status = ?, assignment_reason = ?, eta = ?, updated_at = ?
        WHERE id = ?
      `).run(
        PREPARING_STATUS,
        "waiting_courier",
        "Restoran siparisi onayladi.",
        `${suggestedRestaurantPrepMinutes(target.zone)} dk`,
        nowIso(),
        packageId
      );
      if (isPlatformBackedOrder) {
        updatePlatformOrderStatusByPackage(target, "approved");
      }
      const confirmedPackage = getPackageById(packageId);
      if (isPlatformBackedOrder) {
        const posentegraDecision = enqueuePosentegraRestaurantDecision(confirmedPackage, "confirm", "", req);
        if (!posentegraDecision) {
          await notifyPlatformOrderAccepted(target.source_platform, target.external_order_id || target.external_order_no, session.restaurant_id, confirmedPackage);
          await notifyPlatformOrderPreparing(target.source_platform, target.external_order_id || target.external_order_no, confirmedPackage);
        }
      }
      logger.info("Assignment triggered after restaurant approval", {
        packageId,
        sourcePlatform: target.source_platform || null,
        restaurantId: session.restaurant_id,
      });
      logger.info("Assignment state before approval assignment", {
        packageId,
        previousStatus: target.status,
        nextStatus: PREPARING_STATUS,
        restaurantId: session.restaurant_id,
        zone: target.zone,
      });
      const confirmedForAssignment = getPackageById(packageId);
      if (confirmedForAssignment) {
        persistPackageAssignment(assignPackage(assignmentStateForPackage(confirmedForAssignment), confirmedForAssignment));
      }
      const packageAfterAssignmentAttempt = getPackageById(packageId);
      logger.info("Assignment result after approval", {
        packageId,
        status: packageAfterAssignmentAttempt?.status,
        assignmentStatus: packageAfterAssignmentAttempt?.assignmentStatus,
        assignedCourierId: packageAfterAssignmentAttempt?.assignedCourierId || null,
        lastAssignmentError: packageAfterAssignmentAttempt?.lastAssignmentError || "",
      });
      if (packageAfterAssignmentAttempt?.assignedCourierId) {
        logger.info("Assignment success after approval", {
          packageId,
          courierId: packageAfterAssignmentAttempt.assignedCourierId,
          status: packageAfterAssignmentAttempt.status,
        });
      } else {
        logger.warn("Assignment failed after approval", {
          packageId,
          status: packageAfterAssignmentAttempt?.status || null,
          assignmentStatus: packageAfterAssignmentAttempt?.assignmentStatus || null,
          reason: packageAfterAssignmentAttempt?.lastAssignmentError || "uygun kurye yok",
        });
      }
      broadcastLiveEvent({
        type: "restaurant-confirmed",
        packageId,
        restaurantId: session.restaurant_id,
        courierId: packageAfterAssignmentAttempt?.assignedCourierId || null,
        message: isPlatformBackedOrder ? "Platform siparisi restoran tarafinda onaylandi." : "Manuel paket restoran tarafinda onaylandi.",
      });
      sendJson(res, 200, decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }));
      return;
    }

    if (action === "reject") {
      db.prepare(`
        UPDATE packages
        SET status = ?, assignment_status = ?, assignment_reason = ?, last_assignment_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        REJECTED_STATUS,
        "rejected",
        "Restoran platform siparisini reddetti.",
        trimmed(body.reason) || "Restoran reddetti.",
        nowIso(),
        packageId
      );
      if (isPlatformBackedOrder) {
        updatePlatformOrderStatusByPackage(target, "cancelled");
      }
      const rejectedPackage = getPackageById(packageId);
      if (isPlatformBackedOrder) {
        const posentegraDecision = enqueuePosentegraRestaurantDecision(rejectedPackage, "reject", body.reason, req);
        if (!posentegraDecision) {
          await notifyPlatformOrderRejected(target.source_platform, target.external_order_id || target.external_order_no, body.reason, rejectedPackage);
        }
      }
      broadcastLiveEvent({
        type: "platform-order-rejected",
        restaurantId: session.restaurant_id,
        message: isPlatformBackedOrder ? "Platform siparisi restoran tarafinda reddedildi." : "Manuel paket restoran tarafinda reddedildi.",
      });
      sendJson(res, 200, decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }));
      return;
    }

    sendJson(res, 400, { error: "Gecersiz restoran paketi aksiyonu." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/packages") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Paket olusturma limiti asildi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const restaurantId = trimmed(body.restaurantId ?? body.restaurant_id);
    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(restaurantId);
    if (!restaurantRow) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }
    const draft = {
      restaurantId,
      deliveryAddress: trimmed(body.deliveryAddress ?? body.delivery_address),
      packageType: trimmed(body.packageType ?? body.package_type) || "Standart Paket",
      orderAmount: normalizeMoney(body.orderAmount ?? body.order_amount),
      customerName: trimmed(body.customerName ?? body.customer_name),
      phone: trimmed(body.phone),
      customerAddress: trimmed(body.customerAddress ?? body.customer_address ?? body.deliveryAddress ?? body.delivery_address),
      paymentMethod: trimmed(body.paymentMethod ?? body.payment_method) || "paid_online",
      paymentStatus: trimmed(body.paymentStatus ?? body.payment_status),
      customerNote: trimmed(body.customerNote ?? body.customer_note),
      source: "admin_manual",
      sourcePlatform: "Admin",
      requestedStatus: AWAITING_ASSIGNMENT_STATUS,
    };
    const paymentDraft = validatePaymentDraft(draft);
    if (paymentDraft.error) {
      sendJson(res, 400, { error: paymentDraft.error });
      return;
    }
    draft.paymentMethod = PAYMENT_METHOD_LABELS[paymentDraft.methodCode];
    draft.paymentStatus = paymentDraft.paymentStatus;
    const errors = validatePackageDraft(draft);
    if (errors.length) {
      sendJson(res, 400, { error: errors.join(" ") });
      return;
    }
    const canCreateCustomer = normalizePhone(draft.phone) && draft.customerName && (draft.customerAddress || draft.deliveryAddress);
    const customer = canCreateCustomer ? upsertRestaurantCustomer(restaurantId, {
      name: draft.customerName,
      phone: draft.phone,
      address: draft.customerAddress || draft.deliveryAddress,
    }) : null;
    if (customer) draft.restaurantCustomerId = customer.id;
    const pkg = buildRestaurantPackageRecord(restaurantRow, draft);
    dbFacade.transaction(() => {
      createPackageRecord(pkg, pkg.packageType, { requestId: req.requestId });
      touchRestaurantCustomerOrder(pkg.restaurantCustomerId, restaurantId, pkg.createdAt);
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "package_created_admin",
        packageId: pkg.id,
        restaurantId,
        details: { trackingNo: pkg.trackingNo, orderAmount: pkg.orderAmount },
      });
    });
    rebalancePackages();
    const createdPackage = getPackageById(pkg.id);
    broadcastLiveEvent({
      type: "package-created",
      packageId: pkg.id,
      restaurantId,
      courierId: createdPackage?.assignedCourierId || null,
      source: "admin_manual",
      message: "Admin tarafindan yeni paket olusturuldu.",
    });
    sendJson(res, 201, { ...decorateState({ req }), createdPackage });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/live-map") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const restaurant = getRestaurants({ restaurantId: session.restaurant_id })[0];
    sendJson(res, 200, {
      ok: true,
      restaurant: restaurant ? sanitizeRestaurant(restaurant) : null,
      activeCouriers: liveMapCouriers().map(sanitizeCourier),
      generatedAt: nowIso(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/restaurants") {
    traceCreateEndpoint("ENTER_RESTAURANT_ENDPOINT", req, pathname, { originalPath: originalPathname });
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      logInsertSkipped("restaurants", "missing_admin_session", req);
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      logInsertSkipped("restaurants", "rate_limited", req, { retryAfter });
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Restoran olusturma limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    logger.info("restaurant_create_request_received", {
      requestId: req.requestId,
      route: pathname,
      method: req.method,
      body: maskRestaurantCreateBody(body),
    });

    let restaurant;
    let createdRestaurant;
    try {
      ({ restaurant } = dbFacade.transaction(() => {
        const created = createRestaurantRecord(body, { requestId: req.requestId });
        assertPersistedRecord("restaurants", created.restaurant.id, "restaurant_created", req.requestId);
        writeAuditLog({
          actorRole: "admin",
          actorId: adminActorId(adminSession),
          action: "restaurant_created",
          restaurantId: created.restaurant.id,
          details: {
            name: created.restaurant.name,
            username: created.restaurant.username,
          },
        });
        return {
          restaurant: created.restaurant,
        };
      }));
      logAfterCommit("restaurants", restaurant.id, req.requestId);
      selectInsertedRowOrThrow("restaurants", restaurant.id, req.requestId);
      const createdPosentegraId = await createRestaurantInPosentegraOrRollback(restaurant, req.requestId);
      createdRestaurant = getRestaurants({ restaurantId: restaurant.id })[0];
      if (!createdRestaurant?.id) {
        throw new Error(`restaurants insert committed but getRestaurants returned empty for id ${restaurant.id}`);
      }
      if (createdPosentegraId && createdRestaurant.posentegraId !== createdPosentegraId) {
        logger.error("posentegra_id_db_verify_failed", {
          request_id: req.requestId,
          internal_restaurant_id: restaurant.id,
          posentegra_id: createdPosentegraId || null,
        });
        throw new Error("Posentegra ID DB dogrulamasi basarisiz.");
      }
      logger.info("restaurant_create_transaction_committed", {
        requestId: req.requestId,
        restaurantId: restaurant.id,
        username: restaurant.username,
        selectedRestaurantId: createdRestaurant.id,
        posentegraId: createdRestaurant.posentegraId || null,
      });
      logger.info("restaurant_created", {
        request_id: req.requestId,
        internal_restaurant_id: restaurant.id,
        platform: null,
        platform_restaurant_id: null,
        platform_order_id: null,
        package_id: null,
        tracking_no: null,
        trendyol_restaurant_id: createdRestaurant.trendyolRestaurantId || null,
        getir_restaurant_id: createdRestaurant.getirRestaurantId || null,
        yemeksepeti_restaurant_id: createdRestaurant.yemeksepetiRestaurantId || null,
        migros_restaurant_id: createdRestaurant.migrosRestaurantId || null,
        posentegra_id: createdRestaurant.posentegraId || null,
      });
    } catch (error) {
      logger.error("restaurant_create_failed", {
        requestId: req.requestId,
        route: pathname,
        body: maskRestaurantCreateBody(body),
        error,
      });
      throw error;
    }

    broadcastLiveEvent({
      type: "restaurant-created",
      restaurantId: restaurant.id,
      message: `${restaurant.name} restorani eklendi.`,
    });

    sendJson(res, 201, {
      ...decorateState(),
      createdRestaurant: {
        ...sanitizeRestaurant(createdRestaurant, true),
        verification: posentegraClient.configured() ? Boolean(createdRestaurant.posentegraId) : Boolean(createdRestaurant.id),
      },
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurants") {
    sendJson(res, 403, { error: "Restoran olusturma yalnizca admin panelinden yapilabilir." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/couriers") {
    traceCreateEndpoint("ENTER_COURIER_ENDPOINT", req, pathname, { originalPath: originalPathname });
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      logInsertSkipped("couriers", "missing_admin_session", req);
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      logInsertSkipped("couriers", "rate_limited", req, { retryAfter });
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Kurye olusturma limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { username, password, name, zone, latitude, longitude, available } = validateCourierDraft(body);
    const perPackageFee = body.perPackageFee === undefined || body.perPackageFee === "" ? null : normalizeMoney(body.perPackageFee);

    if (db.prepare("SELECT id FROM couriers WHERE username = ?").get(username)) {
      logInsertSkipped("couriers", "username_already_exists", req, { username });
      sendJson(res, 400, { error: "Bu kullanici adi zaten kullaniliyor." });
      return;
    }

    const courierId = dbFacade.transaction(() => {
      const passwordInfo = hashPassword(password);
      const id = uid("cr");
      const insertSql = `
        INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, per_package_fee, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const insertParams = [
        id,
        name,
        zone,
        latitude,
        longitude,
        available ? 1 : 0,
        available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS,
        username,
        passwordInfo.hash,
        passwordInfo.salt,
        perPackageFee,
        nowIso(),
      ];
      runInsertWithTrace({
        sql: insertSql,
        params: insertParams,
        tableName: "couriers",
        insertedId: id,
        requestId: req.requestId,
      });
      assertPersistedRecord("couriers", id, "courier_created", req.requestId);
      writeAuditLog({
        actorRole: "admin",
        actorId: adminActorId(adminSession),
        action: "courier_created",
        details: {
          username,
          zone,
        },
      });
      return id;
    });
    logAfterCommit("couriers", courierId, req.requestId);
    selectInsertedRowOrThrow("couriers", courierId, req.requestId);

    rebalancePackages();
    broadcastLiveEvent({
      type: "courier-created",
      message: `${name} isimli kurye eklendi.`,
    });
    sendJson(res, 201, {
      ...decorateState(),
      createdCourier: sanitizeCourier(getCourierById(courierId)),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/integrations/orders") {
    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Entegrasyon istek limiti asildi." });
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    const integrationKey = String(req.headers["x-integration-key"] || "").trim();
    const expectedIntegrationKey = trimmed(process.env.DELIVERA_INTEGRATION_KEY);
    const integrationKeyValid =
      Boolean(expectedIntegrationKey) &&
      integrationKey.length === expectedIntegrationKey.length &&
      crypto.timingSafeEqual(Buffer.from(integrationKey), Buffer.from(expectedIntegrationKey));

    if (!integrationKeyValid) {
      logWebhookAttempt({
        restaurantId: body.restaurantId ?? body.restaurant_id,
        sourcePlatform: body.platform ?? body.sourcePlatform,
        externalOrderNo: body.orderId ?? body.externalOrderNo,
        signatureValid: false,
        responseStatus: 403,
        requestBody: raw,
      });
      sendJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }

    let feederDraft;
    try {
      feederDraft = normalizeFeederIntegrationDraft(body);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: body.restaurantId ?? body.restaurant_id,
        sourcePlatform: body.platform ?? body.sourcePlatform,
        externalOrderNo: body.orderId ?? body.externalOrderNo,
        signatureValid: false,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { error: error.message });
      return;
    }

    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(feederDraft.restaurantId);
    if (!restaurantRow) {
      logWebhookAttempt({
        restaurantId: feederDraft.restaurantId,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 404,
        requestBody: raw,
      });
      sendJson(res, 404, { ok: false, error: "Restoran bulunamadi." });
      return;
    }

    const restaurant = {
      id: restaurantRow.id,
      name: restaurantRow.name,
      zone: restaurantRow.zone,
      latitude: restaurantRow.x,
      longitude: restaurantRow.y,
      platforms: parseJson(restaurantRow.platforms_json, []),
      apiKey: restaurantRow.api_key,
      webhookSecret: restaurantRow.webhook_secret,
    };

    if (restaurant.platforms.length > 0 && !restaurant.platforms.includes(feederDraft.sourcePlatform)) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { ok: false, error: "Bu restoran icin platform tanimli degil." });
      return;
    }

    const duplicate = findDuplicatePackage(feederDraft.restaurantId, feederDraft.source, feederDraft.externalOrderId);
    if (duplicate) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 200,
        requestBody: raw,
      });
      sendJson(res, 200, { ok: true, duplicate: true, message: "Bu siparis zaten alinmis, yeni kayit acilmadi." });
      return;
    }

    let pkg;
    try {
      pkg = validateIntegrationDraft(feederDraft, restaurant);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { ok: false, error: error.message });
      return;
    }

    createPackageRecord(pkg, "Platform Siparisi", { requestId: req.requestId });
    assertPersistedRecord("packages", pkg.id, "package_created", req.requestId);
    upsertPlatformOrderRecord({
      platform: feederDraft.sourcePlatform,
      orderId: feederDraft.externalOrderId || feederDraft.externalOrderNo,
      customerName: feederDraft.recipient,
      phone: feederDraft.phone,
      address: feederDraft.address || feederDraft.deliveryAddress,
      totalPrice: feederDraft.orderAmount,
      customerNote: feederDraft.customerNote || feederDraft.note,
      rawPayload: body,
    }, restaurant.id, "pending_approval", { requestId: req.requestId });
    rebalancePackages();
    const created = decorateState().packages.find((item) => item.id === pkg.id);

    writeAuditLog({
      actorRole: "integration",
      actorId: restaurant.id,
      action: "package_created_integration",
      packageId: pkg.id,
      restaurantId: restaurant.id,
      details: {
        sourcePlatform: pkg.sourcePlatform,
        externalOrderNo: pkg.externalOrderNo,
        receiver: "python_worker",
      },
    });

    logger.info("Integration order received from worker", {
      restaurantId: restaurant.id,
      platform: pkg.sourcePlatform,
      orderId: pkg.externalOrderId,
      packageId: pkg.id,
    });

    logWebhookAttempt({
      restaurantId: restaurant.id,
      sourcePlatform: pkg.sourcePlatform,
      externalOrderNo: pkg.externalOrderNo,
      signatureValid: true,
      responseStatus: 201,
      requestBody: raw,
    });
    broadcastLiveEvent({
      type: "integration-order",
      restaurantId: restaurant.id,
      courierId: created?.assignedCourierId || null,
      packageId: pkg.id,
      message: `${pkg.sourcePlatform} siparisi otomatik akisa alindi.`,
    });

    sendJson(res, 201, {
      ok: true,
      message: "Siparis alindi ve otomatik atama calisti.",
      package: created,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/platform/poll-now") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { ok: false, error: "Admin oturumu bulunamadi." });
      return;
    }
    const result = await platformService.pollAllPlatformAccounts({ manual: true, adminId: adminSession.admin_id });
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && pathname === "/api/platform/order") {
    const retryAfter = await applyRateLimit(req, "platformOrder", RATE_LIMITS.platformOrder);
    if (retryAfter !== null) {
      logPlatformEvent({
        platform: null,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 429,
        errorCode: HEALTH_ERROR_CODES.RATE_LIMITED,
        errorMessage: "Platform webhook rate limited",
        retryCount: 0,
        nextRetryAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
      });
      sendRateLimited(res, retryAfter);
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    logger.info("Webhook received", {
      platform: body?.platform || null,
      platformRestaurantId: body?.platformRestaurantId || body?.externalStoreId || body?.external_store_id || null,
      orderId: body?.orderId || body?.order_id || body?.externalOrderId || null,
      requestId: req.requestId,
    });
    const order = normalizeOrder(body.platform, body);
    const match = findPlatformRestaurant(order.platform, order.platformRestaurantId);

    if (!match) {
      const authorizedFallback = requestHasGlobalWebhookSecret(req) || findAuthorizedPlatformWebhookAccount(order.platform, req, raw);
      if (authorizedFallback) {
        const unmatchedOrder = canonicalPlatformOrderToUnmatched(order, body);
        const unmatchedOrderId = persistUnmatchedIncomingOrder(unmatchedOrder, req, { logApiAttempt: false, httpStatus: 202 });
        logWebhookAttempt({
          restaurantId: null,
          sourcePlatform: order.platform,
          externalOrderNo: order.orderId,
          signatureValid: true,
          responseStatus: 202,
          requestBody: raw,
          requestId: req.requestId,
          externalRestaurantId: order.platformRestaurantId,
          externalOrderId: order.orderId,
          isMatched: false,
          status: "unmatched",
        });
        logPlatformEvent({
          platform: order.platform,
          restaurantId: null,
          platformAccountId: authorizedFallback.account?.id || null,
          eventType: "webhook",
          requestId: req.requestId,
          status: "unmatched",
          httpStatus: 202,
          errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
          errorMessage: "Restaurant/platform match failed; order persisted as unmatched",
          metadata: { platformRestaurantId: order.platformRestaurantId, orderId: order.orderId, unmatchedOrderId },
        });
        sendJson(res, 202, {
          ok: true,
          matched: false,
          unmatchedOrderId,
          message: "Order accepted as unmatched",
        });
        return;
      }
      logWebhookAttempt({
        restaurantId: null,
        sourcePlatform: order.platform,
        externalOrderNo: order.orderId,
        signatureValid: false,
        responseStatus: 404,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: order.platform,
        restaurantId: null,
        platformAccountId: null,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 404,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Restaurant/platform match failed",
        metadata: { platformRestaurantId: order.platformRestaurantId, orderId: order.orderId },
      });
      sendJson(res, 404, {
        ok: false,
        error: platformFriendlyError("Restaurant/platform match failed", order.platform),
        platform: order.platform,
        platformRestaurantId: order.platformRestaurantId,
        hint: "Platform panelindeki gerçek Store/Restaurant ID ile aynı değer kullanılmalı.",
      });
      return;
    }
    if (match.account.webhookEnabled === false) {
      db.prepare(`
        UPDATE platform_accounts
        SET connection_status = ?, last_error_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(HEALTH_STATUS.DISABLED, nowIso(), HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED, "Webhook disabled for this platform account", nowIso(), match.account.id);
      logPlatformEvent({
        platform: match.account.platform,
        restaurantId: match.restaurant.id,
        platformAccountId: match.account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 403,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Webhook disabled for this platform account",
      });
      sendJson(res, 403, {
        ok: false,
        error: "Webhook disabled for this platform account",
        platform: order.platform,
        platformRestaurantId: order.platformRestaurantId,
      });
      return;
    }

    const adapter = getPlatformAdapter(normalizePlatformKey(match.account.platform));
    const signature = verifyPlatformSignature({
      req,
      account: match.account,
      restaurant: match.restaurant,
      rawBody: raw,
    });
    if (!signature.ok && !adapter.verifyWebhook(req, match.account) && !verifySimplePlatformSecret(match.account, match.restaurant, req)) {
      db.prepare(`
        UPDATE platform_accounts
        SET last_error = ?,
            connection_status = ?,
            last_error_at = ?,
            last_error_code = ?,
            last_error_message = ?,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
            updated_at = ?
        WHERE id = ?
      `).run("Invalid platform secret", HEALTH_STATUS.ERROR, nowIso(), HEALTH_ERROR_CODES.INVALID_SIGNATURE, "Invalid platform secret", nowIso(), match.account.id);
      logWebhookAttempt({
        restaurantId: match.restaurant.id,
        sourcePlatform: match.account.platform,
        externalOrderNo: order.orderId,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: match.account.platform,
        restaurantId: match.restaurant.id,
        platformAccountId: match.account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 401,
        errorCode: HEALTH_ERROR_CODES.INVALID_SIGNATURE,
        errorMessage: "Invalid platform secret",
        metadata: { orderId: order.orderId },
      });
      sendJson(res, 401, { ok: false, error: "Invalid platform secret" });
      return;
    }

    const result = handleSimplePlatformOrder(order, false, { requestId: req.requestId });
    db.prepare(`
      UPDATE platform_accounts
      SET last_webhook_at = ?,
          last_success_at = ?,
          connection_status = ?,
          last_error = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          consecutive_failures = 0,
          updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), HEALTH_STATUS.CONNECTED, nowIso(), match.account.id);
    logWebhookAttempt({
      restaurantId: match.restaurant.id,
      sourcePlatform: match.account.platform,
      externalOrderNo: order.orderId,
      signatureValid: true,
      responseStatus: result.package?.duplicate ? 200 : 201,
      requestBody: raw,
    });
    logPlatformEvent({
      platform: match.account.platform,
      restaurantId: match.restaurant.id,
      platformAccountId: match.account.id,
      eventType: "webhook",
      requestId: req.requestId,
      status: result.package?.duplicate ? "duplicate" : "success",
      httpStatus: result.package?.duplicate ? 200 : 201,
      errorCode: null,
      errorMessage: result.package?.duplicate ? "Duplicate order controlled by idempotency" : null,
      metadata: { orderId: order.orderId, packageId: result.package?.id || null },
    });
    sendJson(res, result.package?.duplicate ? 200 : 201, {
      ok: true,
      trackingNo: result.package?.trackingNo || "",
      source: "platform_webhook",
      duplicate: Boolean(result.package?.duplicate),
      package: result.package,
    });
    logger.info("Webhook accepted successfully", {
      platform: match.account.platform,
      restaurantId: match.restaurant.id,
      orderId: order.orderId,
      trackingNo: result.package?.trackingNo || null,
      signatureMode: signature.ok ? signature.mode : "adapter_or_legacy_token",
      requestId: req.requestId,
    });
    return;
  }

  const platformWebhookMatch = pathname.match(/^\/api\/platforms\/([^/]+)\/webhook$/);
  if (req.method === "POST" && platformWebhookMatch) {
    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      logPlatformEvent({
        platform: platformWebhookMatch[1],
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 429,
        errorCode: HEALTH_ERROR_CODES.RATE_LIMITED,
        errorMessage: "Platform webhook rate limited",
        nextRetryAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
      });
      sendRateLimited(res, retryAfter);
      return;
    }

    const normalizedPlatform = normalizePlatformFromSlug(platformWebhookMatch[1]);
    if (!normalizedPlatform) {
      sendJson(res, 404, { error: "Platform endpoint bulunamadi." });
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    const account = resolvePlatformAccountForWebhook(normalizedPlatform, req, body);
    if (!account) {
      const authorizedFallback = requestHasGlobalWebhookSecret(req) || findAuthorizedPlatformWebhookAccount(normalizedPlatform, req, raw);
      if (authorizedFallback) {
        const unmatchedOrder = normalizeWebhookOrderPayload({ ...body, platform: normalizedPlatform });
        const unmatchedOrderId = persistUnmatchedIncomingOrder(unmatchedOrder, req, { logApiAttempt: false, httpStatus: 202 });
        logWebhookAttempt({
          restaurantId: null,
          sourcePlatform: normalizedPlatform,
          externalOrderNo: unmatchedOrder.externalOrderId || unmatchedOrder.confirmationId,
          signatureValid: true,
          responseStatus: 202,
          requestBody: raw,
          requestId: req.requestId,
          externalRestaurantId: unmatchedOrder.externalRestaurantId,
          externalOrderId: unmatchedOrder.externalOrderId,
          isMatched: false,
          status: "unmatched",
        });
        logPlatformEvent({
          platform: normalizedPlatform,
          restaurantId: null,
          platformAccountId: authorizedFallback.account?.id || null,
          eventType: "webhook",
          requestId: req.requestId,
          status: "unmatched",
          httpStatus: 202,
          errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
          errorMessage: "Store/vendor match failed; order persisted as unmatched",
          metadata: {
            externalRestaurantId: unmatchedOrder.externalRestaurantId,
            externalOrderId: unmatchedOrder.externalOrderId,
            unmatchedOrderId,
          },
        });
        sendJson(res, 202, {
          ok: true,
          matched: false,
          unmatchedOrderId,
          message: "Order accepted as unmatched",
        });
        return;
      }
      logWebhookAttempt({
        restaurantId: body.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: normalizedPlatform,
        restaurantId: body.restaurantId,
        platformAccountId: null,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 401,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Platform hesabi veya store/vendor eslesmesi bulunamadi.",
      });
      sendJson(res, 401, { error: "Platform hesabi veya store/vendor eslesmesi bulunamadi." });
      return;
    }

    if (!verifyPlatformWebhookAuth(account, req, raw)) {
      db.prepare(`
        UPDATE platform_accounts
        SET connection_status = ?, last_error_at = ?, last_error_code = ?, last_error_message = ?,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1, updated_at = ?
        WHERE id = ?
      `).run(HEALTH_STATUS.ERROR, nowIso(), HEALTH_ERROR_CODES.INVALID_SIGNATURE, "Platform webhook yetkilendirmesi dogrulanamadi.", nowIso(), account.id);
      logWebhookAttempt({
        restaurantId: account.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: normalizedPlatform,
        restaurantId: account.restaurantId,
        platformAccountId: account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 401,
        errorCode: HEALTH_ERROR_CODES.INVALID_SIGNATURE,
        errorMessage: "Platform webhook yetkilendirmesi dogrulanamadi.",
      });
      sendJson(res, 401, { error: "Platform webhook yetkilendirmesi dogrulanamadi." });
      return;
    }

    const restaurant = getRestaurants({ restaurantId: account.restaurantId })[0];
    if (!restaurant) {
      const unmatchedOrder = normalizeWebhookOrderPayload({ ...body, platform: normalizedPlatform });
      const unmatchedOrderId = persistUnmatchedIncomingOrder(unmatchedOrder, req, { logApiAttempt: false, httpStatus: 202 });
      logWebhookAttempt({
        restaurantId: null,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: unmatchedOrder.externalOrderId || unmatchedOrder.confirmationId,
        signatureValid: true,
        responseStatus: 202,
        requestBody: raw,
        requestId: req.requestId,
        externalRestaurantId: unmatchedOrder.externalRestaurantId,
        externalOrderId: unmatchedOrder.externalOrderId,
        isMatched: false,
        status: "unmatched",
      });
      sendJson(res, 202, {
        ok: true,
        matched: false,
        unmatchedOrderId,
        message: "Order accepted as unmatched",
      });
      return;
    }

    let created;
    try {
      const normalizedPayload = normalizeIncomingPlatformPayload(normalizedPlatform, body, account, restaurant);
      created = upsertPlatformPackage(normalizedPlatform, restaurant, normalizedPayload);
      markPlatformAccountVerifiedFromWebhook(account.id, normalizedPlatform);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: account.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: normalizedPlatform,
        restaurantId: account.restaurantId,
        platformAccountId: account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 400,
        errorCode: HEALTH_ERROR_CODES.UNKNOWN_ERROR,
        errorMessage: error.message,
      });
      sendJson(res, 400, { error: error.message });
      return;
    }

    logWebhookAttempt({
      restaurantId: account.restaurantId,
      sourcePlatform: normalizedPlatform,
      externalOrderNo: created?.externalOrderNo,
      signatureValid: true,
      responseStatus: 201,
      requestBody: raw,
    });
    db.prepare(`
      UPDATE platform_accounts
      SET last_webhook_at = ?, last_success_at = ?, connection_status = ?, last_error_code = NULL,
          last_error_message = NULL, consecutive_failures = 0, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), HEALTH_STATUS.CONNECTED, nowIso(), account.id);
    logPlatformEvent({
      platform: normalizedPlatform,
      restaurantId: account.restaurantId,
      platformAccountId: account.id,
      eventType: "webhook",
      requestId: req.requestId,
      status: "success",
      httpStatus: 201,
      metadata: { packageId: created?.id || null, externalOrderNo: created?.externalOrderNo || null },
    });
    broadcastLiveEvent({
      type: "platform-order",
      restaurantId: account.restaurantId,
      courierId: created?.assignedCourierId || null,
      message: `${normalizedPlatform} siparisi sisteme dustu.`,
    });

    sendJson(res, 201, {
      message: `${normalizedPlatform} siparisi alindi.`,
      package: created,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/login") {
    const retryAfter = await applyRateLimit(req, "courierLogin", RATE_LIMITS.courierLogin);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { username, password } = validateCourierLoginDraft(body);
    const courier = db.prepare("SELECT * FROM couriers WHERE username = ?").get(username);

    if (!courier || !verifyPassword(password, courier.password_salt, courier.password_hash)) {
      sendJson(res, 401, { error: "Kullanici adi veya sifre hatali." });
      return;
    }

    const auth = issueSessionPair("courier", courier.id, req);

    const loginLocationAt = new Date().toISOString();
    ensureCourierShiftOpen(courier.id, loginLocationAt);
    db.prepare("UPDATE couriers SET available = 1, status = ?, last_location_at = COALESCE(last_location_at, ?) WHERE id = ?").run(
      COURIER_ONLINE_STATUS,
      loginLocationAt,
      courier.id
    );

    writeAuditLog({
      actorRole: "courier",
      actorId: courier.id,
      action: "courier_logged_in",
      details: {
        username: courier.username,
      },
    });

    setSessionCookie(res, auth.token);
    sendJson(res, 200, {
      ...auth,
      courier: sanitizeCourier({
        id: courier.id,
        name: courier.name,
        zone: courier.zone,
        latitude: courier.x,
        longitude: courier.y,
        available: Boolean(courier.available),
        status: COURIER_ONLINE_STATUS,
        lastLocationAt: courier.last_location_at || loginLocationAt,
        username: courier.username,
        passwordHash: courier.password_hash,
        passwordSalt: courier.password_salt,
      }),
    });
    broadcastLiveEvent({
      type: "courier-online",
      courierId: courier.id,
      message: `${courier.name} online oldu.`,
    });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/courier/me/credentials") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username, password } = body;
    if (!username) {
      sendJson(res, 400, { error: "Kullanici adi zorunludur." });
      return;
    }
    if (db.prepare("SELECT id FROM couriers WHERE username = ? AND id != ?").get(username, session.courier_id)) {
      sendJson(res, 400, { error: "Bu kullanici adi baska bir kurye tarafindan kullaniliyor." });
      return;
    }
    if (password) {
      const passwordInfo = hashPassword(password);
      db.prepare("UPDATE couriers SET username = ?, password_hash = ?, password_salt = ? WHERE id = ?").run(username, passwordInfo.hash, passwordInfo.salt, session.courier_id);
    } else {
      db.prepare("UPDATE couriers SET username = ? WHERE id = ?").run(username, session.courier_id);
    }
    sendJson(res, 200, { message: "Bilgiler guncellendi." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/me") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const workspace = buildCourierWorkspace(session.courier_id, {
      pagination: paginationFromRequest(req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 }),
    });
    if (!workspace) {
      sendJson(res, 401, { error: "Kurye bulunamadi." });
      return;
    }

    sendJson(res, 200, workspace);
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/push/public-key") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Kurye oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, { publicKey: ensureCourierPushConfigured().publicKey });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/push/public-key") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, { publicKey: ensureCourierPushConfigured().publicKey });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/push/subscriptions") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    saveRestaurantPushSubscription(session.restaurant_id, body.subscription || body);
    sendJson(res, 201, { ok: true });
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/restaurant/push/subscriptions") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    deleteRestaurantPushSubscription(session.restaurant_id, body.endpoint);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/push/test") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    broadcastLiveEvent({
      type: "restaurant-push-test",
      restaurantId: session.restaurant_id,
      message: "Restoran bildirim testi gonderildi.",
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/push/subscriptions") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Kurye oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    saveCourierPushSubscription(session.courier_id, body.subscription || body);
    sendJson(res, 201, { ok: true });
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/courier/push/subscriptions") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Kurye oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    deleteCourierPushSubscription(session.courier_id, body.endpoint);
    sendJson(res, 200, { ok: true });
    return;
  }

  const courierPackageGeocodeMatch = pathname.match(/^\/api\/courier\/packages\/([^/]+)\/geocode$/);
  if (req.method === "POST" && courierPackageGeocodeMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const packageId = decodeURIComponent(courierPackageGeocodeMatch[1]);
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND assigned_courier_id = ?").get(packageId, session.courier_id);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const coordinates = await resolvePackageCustomerCoordinates(target);
    if (!coordinates) {
      sendJson(res, 422, { error: "Musteri adresi otomatik olarak haritada bulunamadi. Sokak ve bina numarasi bilgisini kontrol edin." });
      return;
    }

    if (!coordinates.cached) {
      broadcastLiveEvent({
        type: "package-location-resolved",
        restaurantId: target.restaurant_id,
        courierId: session.courier_id,
        message: "Teslimat adresi haritada bulundu.",
      });
    }
    sendJson(res, 200, coordinates);
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/stream") {
    const session = getSessionFromQueryToken(req, "courier");
    if (!session) {
      sendJson(res, 401, { error: "Kurye oturumu bulunamadi." });
      return;
    }
    openLiveStream(req, res, { role: "courier", courierId: session.courier_id });
    return;
  }

  if (req.method === "PATCH" && pathname === "/api/courier/location") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const hasCoordinates = coordinatesAreValid(latitude, longitude);
    const locationStamp = new Date().toISOString();

    if (!hasCoordinates && typeof body.available !== "boolean") {
      sendJson(res, 400, { error: "Gecerli konum veya durum bilgisi gonderilmedi." });
      return;
    }

    const existing = db.prepare("SELECT * FROM couriers WHERE id = ?").get(session.courier_id);
    if (!existing) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }
    const availabilityChanged = typeof body.available === "boolean" && Boolean(existing.available) !== Boolean(body.available);
    const previousLocationAtMs = new Date(existing.last_location_at || "").getTime();
    const previousLocationAgeMs = Date.now() - previousLocationAtMs;
    const previousLocationWasFresh = Number.isFinite(previousLocationAtMs)
      && previousLocationAgeMs >= -60_000
      && previousLocationAgeMs <= COURIER_LOCATION_FRESHNESS_MS;

    if (typeof body.available === "boolean") {
      if (body.available) {
        ensureCourierShiftOpen(session.courier_id, locationStamp);
      } else {
        closeCourierShift(session.courier_id, locationStamp);
      }
    }

    db.prepare(`
      UPDATE couriers
      SET x = ?, y = ?, available = ?, status = ?, last_location_at = ?
      WHERE id = ?
    `).run(
      hasCoordinates ? latitude : existing.x,
      hasCoordinates ? longitude : existing.y,
      typeof body.available === "boolean" ? (body.available ? 1 : 0) : existing.available,
      typeof body.available === "boolean"
        ? (body.available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS)
        : normalizeCourierStatus(existing.status, Boolean(existing.available)),
      locationStamp,
      session.courier_id
    );

    const lightweightLocationOnly = body.locationOnly === true && !availabilityChanged;
    const workspace = lightweightLocationOnly ? null : buildCourierWorkspace(session.courier_id);
    const courier = workspace?.courier || sanitizeCourier(db.prepare("SELECT * FROM couriers WHERE id = ?").get(session.courier_id));
    if (!lightweightLocationOnly || availabilityChanged) {
      writeAuditLog({
        actorRole: "courier",
        actorId: session.courier_id,
        action: "courier_location_updated",
        details: {
          available: courier?.available ?? Boolean(body.available),
          latitude: hasCoordinates ? latitude : existing.x,
          longitude: hasCoordinates ? longitude : existing.y,
        },
      });
    }
    broadcastLiveEvent({
      type: availabilityChanged ? "courier-availability" : "courier-location",
      courierId: session.courier_id,
      latitude: hasCoordinates ? latitude : existing.x,
      longitude: hasCoordinates ? longitude : existing.y,
      available: courier?.available ?? Boolean(body.available),
      at: locationStamp,
      message: availabilityChanged
        ? (body.available ? "Kurye tekrar atamaya acildi." : "Kurye pasife alindi.")
        : "",
    });
    const courierIsNowAvailable = typeof body.available === "boolean"
      ? Boolean(body.available)
      : Boolean(existing.available);
    if (courierIsNowAvailable && (availabilityChanged || !previousLocationWasFresh)) {
      // A courier returning from the background can become eligible after packages
      // have already entered the waiting pool. Re-run assignment once on that
      // stale -> fresh transition; ordinary location heartbeats do not sweep.
      scheduleRebalancePackages();
    }
    sendJson(res, 200, workspace || { courier, packages: [] });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/break") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const action = trimmed(body.action).toLowerCase();
    const stamp = nowIso();
    const currentBreak = getCurrentCourierBreak(session.courier_id);
    if (action === "start") {
      const today = dayKey();
      const usedBreakMs = getCourierBreaks(session.courier_id, 50)
        .filter((item) => String(item.startedAt || "").startsWith(today))
        .reduce((sum, item) => sum + Math.max(0, new Date(item.endedAt || stamp).getTime() - new Date(item.startedAt).getTime()), 0);
      if (usedBreakMs >= 5 * 60 * 1000) {
        sendJson(res, 409, { error: "Bugunku 5 dakikalik mola hakki kullanildi." });
        return;
      }
      const activeCount = Number(db.prepare(`SELECT COUNT(*) AS total FROM packages WHERE assigned_courier_id = ? AND status IN (?, ?, ?)`)
        .get(session.courier_id, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0);
      if (activeCount > 0) {
        sendJson(res, 409, { error: "Aktif paket varken mola baslatilamaz." });
        return;
      }
      if (!getOpenCourierShift(session.courier_id)) {
        sendJson(res, 409, { error: "Mola icin once vardiya baslatilmalidir." });
        return;
      }
      if (!currentBreak) {
        db.prepare(`INSERT INTO courier_breaks (id, courier_id, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`)
          .run(uid("break"), session.courier_id, stamp, stamp, stamp);
      }
      db.prepare("UPDATE couriers SET available = 0, status = ?, last_location_at = ? WHERE id = ?")
        .run(COURIER_OFFLINE_STATUS, stamp, session.courier_id);
    } else if (action === "end") {
      if (!currentBreak) {
        sendJson(res, 409, { error: "Aktif mola bulunamadi." });
        return;
      }
      db.prepare("UPDATE courier_breaks SET ended_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, currentBreak.id);
      db.prepare("UPDATE couriers SET available = 1, status = ?, last_location_at = ? WHERE id = ?")
        .run(COURIER_ONLINE_STATUS, stamp, session.courier_id);
    } else {
      sendJson(res, 400, { error: "Mola islemi start veya end olmalidir." });
      return;
    }
    const workspace = buildCourierWorkspace(session.courier_id);
    broadcastLiveEvent({ type: "courier-break", courierId: session.courier_id, message: action === "start" ? "Kurye molaya cikti." : "Kurye moladan dondu." });
    sendJson(res, 200, workspace || { courier: null, packages: [] });
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/live-map") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }
    const courier = getCourierById(session.courier_id);
    if (!courier) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      courier: sanitizeCourier(courier),
      packages: getCourierPackages(session.courier_id, { limit: 100, offset: 0 }),
      generatedAt: nowIso(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/panel-data") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const row = db.prepare("SELECT data_json, updated_at FROM restaurant_panel_data WHERE restaurant_id = ?").get(session.restaurant_id);
    sendJson(res, 200, {
      ok: true,
      data: parseJson(row?.data_json, {}),
      updatedAt: row?.updated_at || null,
    });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/restaurant/panel-data") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const data = body?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      sendJson(res, 400, { error: "Panel verisi nesne olmalidir." });
      return;
    }
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, "utf8") > 512 * 1024) {
      sendJson(res, 413, { error: "Panel verisi 512 KB sinirini asamaz." });
      return;
    }
    const updatedAt = nowIso();
    db.prepare(`
      INSERT INTO restaurant_panel_data (restaurant_id, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(restaurant_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(session.restaurant_id, serialized, updatedAt);
    writeAuditLog({
      actorRole: "restaurant",
      actorId: session.restaurant_id,
      action: "restaurant_panel_data_updated",
      restaurantId: session.restaurant_id,
      details: { sections: Object.keys(data).slice(0, 30) },
    });
    sendJson(res, 200, { ok: true, data, updatedAt });
    return;
  }

  const courierShiftPlanAcceptMatch = pathname.match(/^\/api\/courier\/shift-plans\/([^/]+)\/accept$/);
  if (req.method === "POST" && courierShiftPlanAcceptMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "courierStatus", RATE_LIMITS.courierStatus);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Vardiya onay limiti asildi." });
      return;
    }

    const planId = courierShiftPlanAcceptMatch[1];
    acceptShiftPlan(session.courier_id, planId);
    const workspace = buildCourierWorkspace(session.courier_id);
    const courier = getCourierById(session.courier_id);
    const acceptedPlan = getCourierShiftPlans(session.courier_id, 12).find((item) => item.id === planId);

    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_shift_plan_accepted",
      details: { planId },
    });
    broadcastLiveEvent({
      type: "shift-plan-accepted",
      courierId: session.courier_id,
      message: `${courier?.name || "Kurye"} ${acceptedPlan?.planDate || ""} vardiya planini kabul etti.`,
    });
    sendJson(res, 200, workspace || { courier: null, packages: [] });
    return;
  }

  const courierPoolClaimMatch = pathname.match(/^\/api\/courier\/pool\/([^/]+)\/claim$/);
  if (req.method === "POST" && courierPoolClaimMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "courierStatus", RATE_LIMITS.courierStatus);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Havuzdan paket alma limiti asildi." });
      return;
    }

    const packageId = courierPoolClaimMatch[1];
    const claimed = claimCourierPoolPackage(session.courier_id, packageId);
    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_pool_package_claimed",
      packageId,
      restaurantId: claimed.target.restaurant_id,
      details: {
        from: normalizeStatus(claimed.target.status),
        to: ACCEPTED_BY_COURIER_STATUS,
        activeLoad: claimed.activeLoad,
        capacity: COURIER_POOL_MAX_ACTIVE_PACKAGES,
      },
    });
    broadcastLiveEvent({
      type: "package-assigned",
      courierId: session.courier_id,
      restaurantId: claimed.target.restaurant_id,
      packageId,
      message: `${claimed.target.tracking_no || packageId} paketi kurye tarafindan havuzdan alindi.`,
    });
    sendJson(res, 200, buildCourierWorkspace(session.courier_id) || { courier: null, packages: [], poolPackages: [] });
    return;
  }

  const courierPackageMatch = pathname.match(/^\/api\/courier\/packages\/([^/]+)\/status$/);
  if (req.method === "PATCH" && courierPackageMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const packageId = courierPackageMatch[1];
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND assigned_courier_id = ?").get(packageId, session.courier_id);

    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const requestedStatus = normalizeStatus(body.status || target.status);
    const currentStatus = normalizeStatus(target.status);
    const paymentMethodCode = normalizePaymentMethodCode(target.payment_method);
    let nextPaymentStatus = body.paymentStatus
      ? normalizePaymentStatus(body.paymentStatus, target.payment_method)
      : normalizePaymentStatus(target.payment_status, target.payment_method);
    let nextPaymentMethod = target.payment_method;
    const collectionNote = trimmed(body.courierCollectionNote ?? body.collectionNote ?? body.note);

    if (!isKnownPackageStatus(body.status || target.status)) {
      sendJson(res, 400, { error: "Gecersiz paket durumu." });
      return;
    }

    if (!COURIER_ALLOWED_STATUSES.has(requestedStatus)) {
      sendJson(res, 400, { error: "Kurye bu duruma gecis yapamaz." });
      return;
    }

    const failureReason = normalizeCourierFailureReason(body.failureReason || body.failure_reason || "");
    const courierIssueReported = requestedStatus === FAILED_STATUS && Boolean(failureReason);
    const directionConflictReported = courierIssueReported && failureReason === "ters_yon";

    if (directionConflictReported) {
      if (![ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(currentStatus)) {
        sendJson(res, 400, { error: "Bu durumdaki paket ters yon nedeniyle havuza alinamaz." });
        return;
      }
      const courierActivePackageCount = Number(db.prepare(`
        SELECT COUNT(*) AS total
        FROM packages
        WHERE assigned_courier_id = ? AND status IN (?, ?, ?)
      `).get(
        session.courier_id,
        ASSIGNED_STATUS,
        ACCEPTED_BY_COURIER_STATUS,
        ON_ROUTE_STATUS
      )?.total || 0);
      if (courierActivePackageCount < AUTO_SAME_RESTAURANT_MAX_ACTIVE_PACKAGES) {
        sendJson(res, 400, { error: "Ters yon bildirimi icin kuryede en az iki aktif paket olmalidir." });
        return;
      }

      clearAssignmentRetry(packageId);
      appendTriedCourier(packageId, session.courier_id);
      const directionStamp = nowIso();
      db.prepare(`
        UPDATE packages
        SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL,
            assigned_at = NULL, accepted_at = NULL, on_route_at = NULL, failed_at = NULL,
            distance_km = NULL, failure_reason = NULL, assignment_reason = ?,
            last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        AWAITING_ASSIGNMENT_STATUS,
        "pending",
        `${target.assigned_courier_name || "Kurye"} teslimat yonlerinin ters oldugunu bildirdi; paket yeniden atama havuzuna alindi.`,
        directionStamp,
        "ters yon nedeniyle yeniden atama",
        directionStamp,
        packageId
      );

      writeAuditLog({
        actorRole: "courier",
        actorId: session.courier_id,
        action: "courier_package_rejected",
        packageId,
        restaurantId: target.restaurant_id,
        details: {
          from: currentStatus,
          to: AWAITING_ASSIGNMENT_STATUS,
          failureReason,
          directionConflict: true,
          courierPackageFeeEligible: false,
          courierCooldownMs: COURIER_REJECTION_COOLDOWN_MS,
          packageCooldownMs: PACKAGE_REJECTION_COOLDOWN_MS,
        },
      });
      rebalancePackages();
      scheduleRebalanceAfterRejectionCooldown();
      const directionWorkspace = buildCourierWorkspace(session.courier_id);
      broadcastLiveEvent({
        type: "assignment-waiting",
        courierId: session.courier_id,
        restaurantId: target.restaurant_id,
        packageId,
        message: `${target.tracking_no || target.id} paketi ters yon nedeniyle havuza dondu; yeniden kurye araniyor.`,
      });
      sendJson(res, 200, directionWorkspace || { courier: null, packages: [] });
      return;
    }

    const nextStatus = courierIssueReported ? CANCELED_STATUS : requestedStatus;

    if (!canTransitionStatus(currentStatus, nextStatus)) {
      sendJson(res, 400, { error: `Gecersiz durum gecisi: ${currentStatus} -> ${nextStatus}` });
      return;
    }

    if (requestedStatus === FAILED_STATUS && !failureReason) {
      sendJson(res, 400, {
        error: "Basarisiz durumuna gecmek icin gecerli bir sorun nedeni secilmelidir.",
        allowedFailureReasons: [...COURIER_FAILURE_REASONS],
      });
      return;
    }

    if (nextStatus === ON_ROUTE_STATUS) {
      const coordinates = await resolvePackageCustomerCoordinates(target);
      if (!coordinates) {
        sendJson(res, 422, {
          error: "Yola cikis baslatilamadi: musteri adresi haritada bulunamadi. Sokak ve bina numarasi bilgisini kontrol edin.",
        });
        return;
      }
      if (!coordinates.cached) {
        broadcastLiveEvent({
          type: "package-location-resolved",
          restaurantId: target.restaurant_id,
          courierId: session.courier_id,
          packageId,
          message: "Musteri konumu otomatik olarak haritada bulundu.",
        });
      }
    }

    const courierSelectablePaymentMethods = ["cash_on_delivery", "card_on_delivery", "restaurant_collected"];
    const courierSelectablePaymentStatuses = [
      CASH_COLLECTED_PAYMENT_STATUS,
      CREDIT_CARD_COLLECTED_PAYMENT_STATUS,
      RESTAURANT_COLLECTED_PAYMENT_STATUS,
      PAYMENT_ISSUE_STATUS,
    ];

    if (nextStatus === DELIVERED_STATUS && courierSelectablePaymentMethods.includes(paymentMethodCode) && !body.paymentStatus) {
      sendJson(res, 400, { error: "Teslim oncesi odeme durumu secilmelidir." });
      return;
    }

    if (nextStatus === DELIVERED_STATUS) {
      const allowedPaymentStatuses = {
        cash_on_delivery: courierSelectablePaymentStatuses,
        card_on_delivery: courierSelectablePaymentStatuses,
        paid_online: [PAID_ONLINE_PAYMENT_STATUS],
        restaurant_collected: courierSelectablePaymentStatuses,
        collected: [COLLECTED_PAYMENT_STATUS],
        payment_issue: [PAYMENT_ISSUE_STATUS],
      }[paymentMethodCode] || [];
      if (!courierSelectablePaymentMethods.includes(paymentMethodCode)) {
        nextPaymentStatus = paymentStatusForMethod(paymentMethodCode);
      }
      if (!allowedPaymentStatuses.includes(nextPaymentStatus)) {
        sendJson(res, 400, { error: "Odeme yontemi ile tahsilat durumu uyusmuyor." });
        return;
      }
    }

    if (nextStatus === DELIVERED_STATUS && !VALID_PAYMENT_STATUSES.has(nextPaymentStatus)) {
      sendJson(res, 400, { error: "Gecersiz odeme/tahsilat durumu." });
      return;
    }

    if (nextStatus === DELIVERED_STATUS) {
      nextPaymentMethod = {
        [CASH_COLLECTED_PAYMENT_STATUS]: "Nakit tahsil edildi",
        [CREDIT_CARD_COLLECTED_PAYMENT_STATUS]: "Kartla tahsil edildi",
        [RESTAURANT_COLLECTED_PAYMENT_STATUS]: "Restoran tahsil etti",
        [PAID_ONLINE_PAYMENT_STATUS]: PAYMENT_METHOD_LABELS.paid_online,
        [COLLECTED_PAYMENT_STATUS]: PAYMENT_METHOD_LABELS.collected,
        [PAYMENT_ISSUE_STATUS]: PAYMENT_METHOD_LABELS.payment_issue,
      }[nextPaymentStatus] || target.payment_method;
    }

    updatePackageLifecycle(packageId, {
      status: nextStatus,
      failureReason: courierIssueReported ? failureReason : "",
      paymentMethod: nextPaymentMethod,
      paymentStatus: nextPaymentStatus,
      paymentCollectedBy: normalizeCollectedBy(nextPaymentStatus, target.payment_collected_by),
      collectedAmount: nextPaymentStatus === PAYMENT_ISSUE_STATUS ? 0 : target.order_amount,
      courierCollectionNote: collectionNote,
    }, {
      status: target.status,
      paymentStatus: target.payment_status,
      paymentCollectedBy: target.payment_collected_by,
      collectedAmount: target.collected_amount,
      courierCollectionNote: target.courier_collection_note,
      orderAmount: target.order_amount,
      failureReason: target.failure_reason,
      assignedCourierId: target.assigned_courier_id,
      assignedCourierName: target.assigned_courier_name,
      assignedAt: target.assigned_at,
      acceptedAt: target.accepted_at,
      onRouteAt: target.on_route_at,
      deliveredAt: target.delivered_at,
      failedAt: target.failed_at,
      lastAssignmentAttemptAt: target.last_assignment_attempt_at,
      lastAssignmentError: target.last_assignment_error,
      paymentMethod: target.payment_method,
    });
    rebalancePackages();
    if (nextStatus === DELIVERED_STATUS) {
      const deliveredPackage = getPackageById(packageId);
      updatePlatformOrderStatusByPackage(deliveredPackage || target, "completed");
      if (isPlatformBackedPackage(target)) {
        await notifyPlatformOrderDelivered(target.source_platform, target.external_order_id || target.external_order_no, deliveredPackage);
      }
    }
    if (courierIssueReported) {
      const cancelledPackage = getPackageById(packageId);
      updatePlatformOrderStatusByPackage(cancelledPackage || target, "cancelled");
    }

    const workspace = buildCourierWorkspace(session.courier_id);
    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_package_status_changed",
      packageId,
      restaurantId: target.restaurant_id,
      details: {
        from: currentStatus,
        to: nextStatus,
        failureReason: courierIssueReported ? failureReason : null,
        paymentMethod: nextPaymentMethod,
        paymentStatus: nextPaymentStatus,
        courierPackageFeeEligible: courierIssueReported,
      },
    });
    broadcastLiveEvent({
      type: "package-status",
      courierId: session.courier_id,
      restaurantId: target.restaurant_id,
      message: `Paket durumu ${nextStatus} oldu.`,
    });
    sendJson(res, 200, workspace || { courier: null, packages: [] });
    return;
  }

  const courierPackageRejectMatch = pathname.match(/^\/api\/courier\/packages\/([^/]+)\/reject$/);
  if (req.method === "POST" && courierPackageRejectMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "courierStatus", RATE_LIMITS.courierStatus);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Paket islem limiti asildi." });
      return;
    }

    const packageId = courierPackageRejectMatch[1];
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND assigned_courier_id = ?").get(packageId, session.courier_id);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    if (normalizeStatus(target.status) !== ASSIGNED_STATUS) {
      sendJson(res, 400, { error: "Bu paket artik teklif durumunda degil." });
      return;
    }

    clearAssignmentRetry(packageId);
    appendTriedCourier(packageId, session.courier_id);
    const stamp = nowIso();
    db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL,
          assigned_at = NULL, distance_km = NULL, assignment_reason = ?, last_assignment_attempt_at = ?,
          last_assignment_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      AWAITING_ASSIGNMENT_STATUS,
      "pending",
      `${target.assigned_courier_name || "Kurye"} paketi reddetti; yeniden atama bekleniyor.`,
      stamp,
      "kurye reddetti",
      stamp,
      packageId
    );

    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_package_rejected",
      packageId,
      restaurantId: target.restaurant_id,
      details: {
        from: ASSIGNED_STATUS,
        to: AWAITING_ASSIGNMENT_STATUS,
        courierCooldownMs: COURIER_REJECTION_COOLDOWN_MS,
        packageCooldownMs: PACKAGE_REJECTION_COOLDOWN_MS,
      },
    });
    rebalancePackages();
    scheduleRebalanceAfterRejectionCooldown();
    const workspace = buildCourierWorkspace(session.courier_id);
    broadcastLiveEvent({
      type: "assignment-waiting",
      courierId: session.courier_id,
      restaurantId: target.restaurant_id,
      message: `${target.tracking_no || target.id} paketi kurye tarafindan reddedildi, yeniden atama araniyor.`,
    });
    sendJson(res, 200, workspace || { courier: null, packages: [] });
    return;
  }

  if (req.method === "POST" && (pathname === "/api/courier/day-close" || pathname === "/api/courier/day-end")) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const activePackageCount = Number(db.prepare(`
      SELECT COUNT(*) AS total FROM packages
      WHERE assigned_courier_id = ? AND status IN (?, ?, ?)
    `).get(session.courier_id, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0);
    if (activePackageCount > 0) {
      sendJson(res, 409, { error: `Aktif ${activePackageCount} paket tamamlanmadan gun sonu alinamaz.` });
      return;
    }

    const reportDate = dayKey();
    const existingReport = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(session.courier_id, reportDate);
    if (existingReport) {
      sendJson(res, 409, {
        error: "Bugunun gun sonu raporu daha once gonderildi. Her kurye gunde yalnizca bir kez gun sonu yapabilir.",
        dayCloseReport: mapCourierDailyReportRow(existingReport),
      });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const summary = upsertCourierDailyReport(session.courier_id, reportDate, {
      courierNote: body.courierNote ?? body.note,
    });
    upsertCashReconciliation(session.courier_id, reportDate, summary);
    closeCourierShift(session.courier_id);
    db.prepare("UPDATE couriers SET available = 0, status = ?, last_location_at = ? WHERE id = ?")
      .run(COURIER_OFFLINE_STATUS, nowIso(), session.courier_id);
    const workspace = buildCourierWorkspace(session.courier_id);
    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_day_closed",
      details: {
        reportDate,
        deliveredCount: summary.deliveredCount,
        totalAmount: summary.totalAmount,
      },
    });
    broadcastLiveEvent({
      type: "courier-day-close",
      courierId: session.courier_id,
      message: "Kurye gun sonu raporu olustu.",
    });
    sendJson(res, 200, {
      ...(workspace || { courier: null, packages: [], dayMetrics: null }),
      dayCloseReport: summary,
      courierDailyReports: getCourierDailyReports(50),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/courier-day-end-reports") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, { ok: true, reports: getCourierDailyReports(200) });
    return;
  }

  const adminCourierDayEndApproveMatch = pathname.match(/^\/api\/admin\/courier-day-end-reports\/([^/]+)\/approve$/);
  if (req.method === "POST" && adminCourierDayEndApproveMatch) {
    pathname = `/api/admin/day-close/${adminCourierDayEndApproveMatch[1]}/approve`;
  }

  const adminCourierDayEndRejectMatch = pathname.match(/^\/api\/admin\/courier-day-end-reports\/([^/]+)\/reject$/);
  if (req.method === "POST" && adminCourierDayEndRejectMatch) {
    pathname = `/api/admin/day-close/${adminCourierDayEndRejectMatch[1]}/reject`;
  }

  if (req.method === "GET" && pathname === "/api/admin/shift-plans") {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const planDate = trimmed(url.searchParams.get("date")) || dayKey();
    sendJson(res, 200, { ok: true, shiftPlans: getShiftPlans(planDate), shiftPlanSummary: summarizeShiftPlans(planDate) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/courier-performance") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const selectedDate = trimmed(url.searchParams.get("date")) || dayKey();
    sendJson(res, 200, { ok: true, ...getCourierPerformanceReport(selectedDate) });
    return;
  }

  const adminShiftPlanMatch = pathname.match(/^\/api\/admin\/shift-plans\/([^/]+)$/);
  if (req.method === "DELETE" && adminShiftPlanMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const plan = db.prepare("SELECT * FROM courier_shift_plans WHERE id = ?").get(adminShiftPlanMatch[1]);
    if (!plan) { sendJson(res, 404, { error: "Vardiya plani bulunamadi." }); return; }
    db.prepare("DELETE FROM courier_shift_plans WHERE id = ?").run(plan.id);
    writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "courier_shift_plan_deleted", details: { planId: plan.id, courierId: plan.courier_id } });
    broadcastLiveEvent({ type: "shift-plan-offer", courierId: plan.courier_id, message: "Vardiya plani admin tarafindan kaldirildi." });
    sendJson(res, 200, { ok: true, ...decorateState({ req }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/shift-plans") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Vardiya planlama limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const courierId = trimmed(body.courierId);
    const planDate = trimmed(body.planDate) || dayKey();
    const startTime = trimmed(body.startTime) || "10:00";
    const endTime = trimmed(body.endTime) || "18:00";
    const zone = trimmed(body.zone);

    if (!courierId) {
      sendJson(res, 400, { error: "Kurye secilmelidir." });
      return;
    }

    const shiftPlanId = upsertShiftPlan(courierId, planDate, startTime, endTime, zone);
    const createdShiftPlan = getShiftPlans(planDate).find((plan) => plan.id === shiftPlanId) || null;
    if (!createdShiftPlan?.id) {
      throw new Error(`courier_shift_plans insert verification failed for id ${shiftPlanId}`);
    }
    const courier = getCourierById(courierId);
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_shift_planned",
      details: { courierId, planDate, startTime, endTime, zone },
    });
    broadcastLiveEvent({
      type: "shift-plan-offer",
      courierId,
      message: `${courier?.name || "Kurye"} icin ${planDate} ${startTime}-${endTime} vardiya plani olusturuldu. 1 saat icinde onay bekleniyor.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      createdShiftPlan,
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/management-records") {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    sendJson(res, 200, { ok: true, managementRecords: getManagementRecords({ recordType: url.searchParams.get("type"), subjectType: url.searchParams.get("subjectType"), subjectId: url.searchParams.get("subjectId"), status: url.searchParams.get("status") }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/management-records") {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const { json: body } = await readRequestBody(req);
    try {
      const managementRecord = createManagementRecord(body);
      syncManagementRecordAccounting(managementRecord);
      writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "management_record_created", details: { recordId: managementRecord.id, recordType: managementRecord.recordType, subjectId: managementRecord.subjectId } });
      broadcastLiveEvent({ type: "workspace-update", courierId: managementRecord.subjectType === "courier" ? managementRecord.subjectId : undefined, restaurantId: managementRecord.subjectType === "restaurant" ? managementRecord.subjectId : undefined, message: `${managementRecord.title} kaydi olusturuldu.` });
      sendJson(res, 201, { ok: true, managementRecord, ...decorateState({ req }) });
    } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
    return;
  }

  const adminManagementRecordMatch = pathname.match(/^\/api\/admin\/management-records\/([^/]+)$/);
  if (req.method === "PATCH" && adminManagementRecordMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const { json: body } = await readRequestBody(req);
    try {
      const managementRecord = updateManagementRecord(adminManagementRecordMatch[1], body);
      syncManagementRecordAccounting(managementRecord);
      writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "management_record_updated", details: { recordId: managementRecord.id, status: managementRecord.status } });
      broadcastLiveEvent({ type: "workspace-update", courierId: managementRecord.subjectType === "courier" ? managementRecord.subjectId : undefined, restaurantId: managementRecord.subjectType === "restaurant" ? managementRecord.subjectId : undefined, message: `${managementRecord.title} kaydi guncellendi.` });
      sendJson(res, 200, { ok: true, managementRecord, ...decorateState({ req }) });
    } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
    return;
  }

  if (req.method === "DELETE" && adminManagementRecordMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const currentRecordRow = db.prepare("SELECT * FROM management_records WHERE id = ?").get(adminManagementRecordMatch[1]);
    const currentRecord = currentRecordRow ? mapManagementRecord(currentRecordRow) : null;
    const result = db.prepare("DELETE FROM management_records WHERE id = ?").run(adminManagementRecordMatch[1]);
    if (!result.changes) { sendJson(res, 404, { error: "Yonetim kaydi bulunamadi." }); return; }
    writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "management_record_deleted", details: { recordId: adminManagementRecordMatch[1] } });
    syncManagementRecordAccounting(currentRecord);
    broadcastLiveEvent({ type: "workspace-update", courierId: currentRecord?.subjectType === "courier" ? currentRecord.subjectId : undefined, restaurantId: currentRecord?.subjectType === "restaurant" ? currentRecord.subjectId : undefined, message: `${currentRecord?.title || "Yonetim"} kaydi silindi.` });
    sendJson(res, 200, { ok: true, ...decorateState({ req }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/zones") {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const { json: body } = await readRequestBody(req);
    const name = trimmed(body.name);
    if (!name) { sendJson(res, 400, { error: "Bolge adi zorunludur." }); return; }
    db.prepare("INSERT OR IGNORE INTO zones (name) VALUES (?)").run(name);
    writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "zone_created", details: { name } });
    sendJson(res, 201, { ok: true, ...decorateState({ req }) });
    return;
  }

  const adminZoneMatch = pathname.match(/^\/api\/admin\/zones\/([^/]+)$/);
  if (req.method === "DELETE" && adminZoneMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    const name = decodeURIComponent(adminZoneMatch[1]);
    const inUse = countTable("couriers", "zone = ?", [name]) + countTable("restaurants", "zone = ?", [name]);
    if (inUse) { sendJson(res, 409, { error: "Bu bolge kurye veya isletme tarafindan kullaniliyor." }); return; }
    db.prepare("DELETE FROM zones WHERE name = ?").run(name);
    writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "zone_deleted", details: { name } });
    sendJson(res, 200, { ok: true, ...decorateState({ req }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/rebalance") {
    const adminSession = getAdminSession(req);
    if (!adminSession) { sendJson(res, 401, { error: "Admin oturumu bulunamadi." }); return; }
    rebalancePackages();
    writeAuditLog({ actorRole: "admin", actorId: adminActorId(adminSession), action: "manual_rebalance_triggered" });
    sendJson(res, 200, { ok: true, ...decorateState({ req }) });
    return;
  }

  const adminTestPlatformOrderMatch = pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/test-platform-order$/);
  if (req.method === "POST" && adminTestPlatformOrderMatch) {
    if (IS_PRODUCTION) {
      productionDisabled(res);
      return;
    }
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const restaurantId = adminTestPlatformOrderMatch[1];
    const restaurant = getRestaurants({ restaurantId })[0];
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    const account = getPlatformAccounts({ restaurantId }).find((item) => item.active);
    if (!account) {
      sendJson(res, 400, { error: "Bu restoran icin aktif platform hesabi yok." });
      return;
    }

    const result = handleSimplePlatformOrder({
      platform: account.platform,
      platformRestaurantId: account.externalStoreId,
      orderId: `ADMIN-TEST-${Date.now()}`,
      customerName: "Admin Test Musteri",
      phone: "05555555555",
      address: `${restaurant.zone} admin test siparis adresi`,
      totalPrice: 250,
      paymentMethod: "Online Odeme",
      customerNote: "Admin test platform siparisi",
      items: [{ id: "admin-test-1", name: "Test Menu", quantity: 1, price: 250 }],
    }, false, { requestId: req.requestId });
    if (!result.ok) {
      sendJson(res, result.statusCode || 404, { ok: false, error: result.error });
      return;
    }

    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "admin_test_platform_order_sent",
      restaurantId,
      packageId: result.package?.id || null,
      details: {
        platform: account.platform,
        externalStoreId: account.externalStoreId,
      },
    });
    sendJson(res, 200, {
      ok: true,
      package: result.package,
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/announcements") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Duyuru gonderme limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const title = trimmed(body.title);
    const message = trimmed(body.message);
    const targetRole = trimmed(body.targetRole) || "courier";

    if (!title || !message) {
      sendJson(res, 400, { error: "Baslik ve duyuru mesaji zorunludur." });
      return;
    }

    const announcementId = createAnnouncement(targetRole, title, message);
    const createdAnnouncement = getAnnouncementById(announcementId);
    if (!createdAnnouncement?.id) {
      throw new Error(`announcements insert verification failed for id ${announcementId}`);
    }
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "announcement_created",
      details: { targetRole, title },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      message: `${title} duyurusu yayinlandi.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      createdAnnouncement,
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const enhancedDayCloseApproveMatch = pathname.match(/^\/api\/admin\/day-close\/([^\/]+)\/approve$/);
  if (req.method === "POST" && enhancedDayCloseApproveMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const reportId = enhancedDayCloseApproveMatch[1];
    const stamp = nowIso();
    const result = db.prepare("UPDATE courier_daily_reports SET status = 'approved', admin_note = ?, approved_at = ?, updated_at = ? WHERE id = ?").run(trimmed(body.adminNote), stamp, stamp, reportId);
    if (!result.changes) {
      sendJson(res, 404, { error: "Kurye gun sonu raporu bulunamadi." });
      return;
    }
    const report = db.prepare("SELECT * FROM courier_daily_reports WHERE id = ?").get(reportId);
    const settlements = upsertSettlementsForApprovedReport(report);
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_day_close_approved",
      details: { reportId, settlementCount: settlements.length },
    });
    broadcastLiveEvent({ type: "workspace-update", message: "Kurye gun sonu raporu onaylandi." });
    sendJson(res, 200, { success: true, ...decorateState({ req }), auditLogs: getAuditLogs(20) });
    return;
  }

  const adminDayCloseRejectMatch = pathname.match(/^\/api\/admin\/day-close\/([^\/]+)\/reject$/);
  if (req.method === "POST" && adminDayCloseRejectMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const reason = trimmed(body.adminNote || body.reason);
    if (!reason) {
      sendJson(res, 400, { error: "Red sebebi zorunludur." });
      return;
    }
    const result = db.prepare("UPDATE courier_daily_reports SET status = 'rejected', admin_note = ?, updated_at = ? WHERE id = ?").run(reason, nowIso(), adminDayCloseRejectMatch[1]);
    if (!result.changes) {
      sendJson(res, 404, { error: "Kurye gun sonu raporu bulunamadi." });
      return;
    }
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_day_close_rejected",
      details: { reportId: adminDayCloseRejectMatch[1], reason },
    });
    broadcastLiveEvent({ type: "workspace-update", message: "Kurye gun sonu raporu reddedildi." });
    sendJson(res, 200, { success: true, ...decorateState({ req }), auditLogs: getAuditLogs(20) });
    return;
  }

  const adminDayCloseEditMatch = pathname.match(/^\/api\/admin\/day-close\/([^\/]+)$/);
  if (req.method === "PATCH" && adminDayCloseEditMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const report = db.prepare("SELECT * FROM courier_daily_reports WHERE id = ?").get(adminDayCloseEditMatch[1]);
    if (!report) {
      sendJson(res, 404, { error: "Kurye gun sonu raporu bulunamadi." });
      return;
    }
    if (report.status === "approved") {
      sendJson(res, 400, { error: "Onaylanan gun sonu raporu kilitlidir." });
      return;
    }
    db.prepare(`
      UPDATE courier_daily_reports
      SET cash_collected_amount = ?, credit_card_amount = ?, paid_online_amount = ?, restaurant_collected_amount = ?,
          collected_total = ?, failed_collection_total = ?, total_amount = ?, admin_note = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalizeMoney(body.cashTotal ?? body.cashCollectedAmount ?? report.cash_collected_amount),
      normalizeMoney(body.cardTotal ?? body.creditCardAmount ?? report.credit_card_amount),
      normalizeMoney(body.onlineTotal ?? body.paidOnlineAmount ?? report.paid_online_amount),
      normalizeMoney(body.restaurantCollectedAmount ?? report.restaurant_collected_amount),
      normalizeMoney(body.collectedTotal ?? (
        normalizeMoney(body.cashTotal ?? body.cashCollectedAmount ?? report.cash_collected_amount) +
        normalizeMoney(body.cardTotal ?? body.creditCardAmount ?? report.credit_card_amount) +
        normalizeMoney(body.restaurantCollectedAmount ?? report.restaurant_collected_amount)
      )),
      normalizeMoney(body.failedCollectionTotal ?? report.failed_collection_total),
      normalizeMoney(
        normalizeMoney(body.cashTotal ?? body.cashCollectedAmount ?? report.cash_collected_amount) +
        normalizeMoney(body.cardTotal ?? body.creditCardAmount ?? report.credit_card_amount) +
        normalizeMoney(body.onlineTotal ?? body.paidOnlineAmount ?? report.paid_online_amount) +
        normalizeMoney(body.restaurantCollectedAmount ?? report.restaurant_collected_amount) +
        normalizeMoney(body.failedCollectionTotal ?? report.failed_collection_total)
      ),
      trimmed(body.adminNote ?? report.admin_note),
      nowIso(),
      report.id
    );
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_day_close_edited",
      details: { reportId: report.id },
    });
    sendJson(res, 200, { success: true, ...decorateState({ req }), auditLogs: getAuditLogs(20) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/accounting/restaurants") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const startDate = trimmed(url.searchParams.get("startDate")) || dayKey();
    const endDate = trimmed(url.searchParams.get("endDate")) || startDate;
    const restaurantId = trimmed(url.searchParams.get("restaurantId"));
    sendJson(res, 200, {
      ok: true,
      restaurantAccounting: buildRestaurantAccounting({ startDate, endDate, restaurantId }),
      restaurantSettlements: getRestaurantSettlements(50),
    });
    return;
  }

  const adminAccountingDetailsMatch = pathname.match(/^\/api\/admin\/accounting\/restaurants\/([^/]+)\/details$/);
  if (req.method === "GET" && adminAccountingDetailsMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const restaurantId = adminAccountingDetailsMatch[1];
    const restaurant = db.prepare("SELECT id FROM restaurants WHERE id = ?").get(restaurantId);
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      details: buildRestaurantAccountingDetails(restaurantId, {
        startDate: url.searchParams.get("startDate"),
        endDate: url.searchParams.get("endDate"),
        paymentMethod: url.searchParams.get("paymentMethod"),
        paymentStatus: url.searchParams.get("paymentStatus"),
        collectionStatus: url.searchParams.get("collectionStatus"),
        courierId: url.searchParams.get("courierId"),
        paidStatus: url.searchParams.get("paidStatus"),
      }),
    });
    return;
  }

  const adminAccountingMarkPaidMatch = pathname.match(/^\/api\/admin\/accounting\/restaurants\/([^/]+)\/mark-paid$/);
  if (req.method === "POST" && adminAccountingMarkPaidMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const startDate = trimmed(body.startDate) || dayKey();
    const endDate = trimmed(body.endDate) || startDate;
    const settlement = upsertRestaurantSettlement(adminAccountingMarkPaidMatch[1], startDate, endDate, {
      status: "paid",
      paidAt: body.paidAt,
      note: body.note,
    });
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "restaurant_settlement_marked_paid",
      restaurantId: adminAccountingMarkPaidMatch[1],
      details: { settlementId: settlement.id, startDate, endDate },
    });
    sendJson(res, 200, { ok: true, settlement, ...decorateState({ req }), auditLogs: getAuditLogs(20) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/settlements") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, { ok: true, settlements: getRestaurantSettlements(200) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/settlements") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const restaurantId = trimmed(body.restaurantId);
    const startDate = trimmed(body.startDate);
    const endDate = trimmed(body.endDate);
    if (!restaurantId || !startDate || !endDate) {
      sendJson(res, 400, { error: "Restoran ve tarih araligi zorunludur." });
      return;
    }
    const settlement = upsertRestaurantSettlement(restaurantId, startDate, endDate, {
      status: body.status || "paid",
      paidAt: body.paidAt,
      note: body.note,
    });
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "restaurant_settlement_updated",
      restaurantId,
      details: { settlementId: settlement.id, status: settlement.status },
    });
    sendJson(res, 200, { ok: true, settlement, ...decorateState({ req }), auditLogs: getAuditLogs(20) });
    return;
  }

  const adminDayCloseApproveMatch = pathname.match(/^\/api\/admin\/day-close\/([^\/]+)\/approve$/);
  if (req.method === "POST" && adminDayCloseApproveMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const reportId = adminDayCloseApproveMatch[1];

    try {
      const result = db.prepare("UPDATE courier_daily_reports SET status = 'approved', updated_at = ? WHERE id = ?").run(nowIso(), reportId);
      if (!result.changes) {
        sendJson(res, 404, { error: "Kurye gun sonu raporu bulunamadi." });
        return;
      }

      broadcastLiveEvent({ type: "workspace-update", message: "Kurye gün sonu raporu onaylandı." });
      sendJson(res, 200, {
        success: true,
        ...decorateState({ req }),
        auditLogs: getAuditLogs(20),
      });
    } catch (err) {
      sendJson(res, 500, { error: "Rapor onaylanirken hata olustu." });
    }
    return;
  }

  const announcementMatch = pathname.match(/^\/api\/admin\/announcements\/([^/]+)$/);
  if (req.method === "DELETE" && announcementMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    if (!deactivateAnnouncement(announcementMatch[1])) {
      sendJson(res, 404, { error: "Duyuru bulunamadi." });
      return;
    }

    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "announcement_cleared",
      details: { announcementId: announcementMatch[1] },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      message: "Operasyon duyurusu kaldirildi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/announcements/clear") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    clearAnnouncements("courier");
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "announcements_cleared",
      details: { targetRole: "courier" },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      message: "Tum kurye duyurulari sifirlandi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const reconciliationMatch = pathname.match(/^\/api\/admin\/cash-reconciliations\/([^/]+)$/);
  if (req.method === "PATCH" && reconciliationMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Nakit mutabakat limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const updated = updateCashReconciliationRecord(reconciliationMatch[1], body);
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "cash_reconciliation_updated",
      details: {
        reconciliationId: updated.id,
        status: updated.status,
        reportedCash: updated.reported_cash,
      },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      courierId: updated.courier_id,
      message: "Nakit mutabakat kaydi guncellendi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const adminCourierMatch = pathname.match(/^\/api\/admin\/couriers\/([^/]+)$/);
  if (req.method === "DELETE" && adminCourierMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const targetId = adminCourierMatch[1];
    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(targetId);
    if (!courier) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }
    const reassignedPackageIds = db.prepare(`
      SELECT id FROM packages
      WHERE assigned_courier_id = ?
        AND status IN ('assigned', 'accepted_by_courier', 'on_route')
    `).all(targetId).map((row) => row.id);
    reassignedPackageIds.forEach((packageId) => clearAssignmentRetry(packageId));
    dbFacade.transaction((txDb) => {
      txDb.prepare("DELETE FROM courier_sessions WHERE courier_id = ?").run(targetId);
      txDb.prepare("DELETE FROM refresh_tokens WHERE actor_role = 'courier' AND actor_id = ?").run(targetId);
      txDb.prepare("DELETE FROM courier_push_subscriptions WHERE courier_id = ?").run(targetId);
      txDb.prepare(`
        UPDATE packages
        SET assigned_courier_id = NULL,
            assigned_courier_name = NULL,
            assigned_at = NULL,
            accepted_at = NULL,
            on_route_at = NULL,
            status = 'awaiting_assignment',
            assignment_status = 'pending',
            assignment_reason = 'Atanan kurye admin tarafindan silindi; paket yeniden atama havuzuna alindi.',
            last_assignment_attempt_at = NULL,
            last_assignment_error = NULL,
            updated_at = ?
        WHERE assigned_courier_id = ?
          AND status IN ('assigned', 'accepted_by_courier', 'on_route')
      `).run(nowIso(), targetId);
      txDb.prepare("DELETE FROM courier_breaks WHERE courier_id = ?").run(targetId);
      txDb.prepare("DELETE FROM courier_shifts WHERE courier_id = ?").run(targetId);
      txDb.prepare("DELETE FROM courier_shift_plans WHERE courier_id = ?").run(targetId);
      txDb.prepare("DELETE FROM cash_reconciliations WHERE courier_id = ?").run(targetId);
      txDb.prepare(`
        DELETE FROM courier_earning_items
        WHERE courier_earning_id IN (SELECT id FROM courier_earnings WHERE courier_id = ?)
      `).run(targetId);
      txDb.prepare("DELETE FROM courier_earnings WHERE courier_id = ?").run(targetId);
      txDb.prepare("DELETE FROM couriers WHERE id = ?").run(targetId);
    });
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_deleted",
      details: { username: courier.username },
    });
    broadcastLiveEvent({
      type: "courier-deleted",
      message: `${courier.name} sistemden silindi.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "PUT" && adminCourierMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const targetId = adminCourierMatch[1];
    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(targetId);
    if (!courier) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username, password, name, zone } = body;
    const perPackageFee = body.perPackageFee === undefined
      ? courier.per_package_fee
      : body.perPackageFee === ""
        ? null
        : normalizeMoney(body.perPackageFee);
    if (username && db.prepare("SELECT id FROM couriers WHERE username = ? AND id != ?").get(username, targetId)) {
      sendJson(res, 400, { error: "Bu kullanici adi baska bir kurye tarafindan kullaniliyor." });
      return;
    }
    if (password) {
      const passwordInfo = hashPassword(password);
      db.prepare("UPDATE couriers SET name = ?, zone = ?, username = ?, password_hash = ?, password_salt = ?, per_package_fee = ? WHERE id = ?").run(name || courier.name, zone || courier.zone, username || courier.username, passwordInfo.hash, passwordInfo.salt, perPackageFee, targetId);
    } else {
      db.prepare("UPDATE couriers SET name = ?, zone = ?, username = ?, per_package_fee = ? WHERE id = ?").run(name || courier.name, zone || courier.zone, username || courier.username, perPackageFee, targetId);
    }
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_updated",
      details: { username: courier.username },
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const availabilityMatch = pathname.match(/^\/api\/admin\/couriers\/([^/]+)\/availability$/);
  if (req.method === "PATCH" && availabilityMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Kurye guncelleme limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    if (body.available) {
      ensureCourierShiftOpen(availabilityMatch[1]);
    } else {
      closeCourierShift(availabilityMatch[1]);
    }
    db.prepare("UPDATE couriers SET available = ?, status = ? WHERE id = ?").run(
      body.available ? 1 : 0,
      body.available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS,
      availabilityMatch[1]
    );
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_availability_changed",
      details: {
        courierId: availabilityMatch[1],
        available: Boolean(body.available),
      },
    });
    broadcastLiveEvent({
      type: "courier-availability",
      courierId: availabilityMatch[1],
      message: body.available ? "Kurye admin tarafindan aktif edildi." : "Kurye admin tarafindan pasife alindi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Paket guncelleme limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(statusMatch[1]);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const currentStatus = normalizeStatus(target.status);
    if (!isKnownPackageStatus(body.status || AWAITING_ASSIGNMENT_STATUS)) {
      sendJson(res, 400, { error: "Gecersiz paket durumu." });
      return;
    }
    const nextStatus = normalizeStatus(body.status || AWAITING_ASSIGNMENT_STATUS);
    if (!canTransitionStatus(currentStatus, nextStatus)) {
      sendJson(res, 400, { error: `Gecersiz durum gecisi: ${currentStatus} -> ${nextStatus}` });
      return;
    }

    updatePackageLifecycle(statusMatch[1], {
      status: nextStatus,
      paymentStatus: body.paymentStatus || target.payment_status,
      failureReason: trimmed(body.failureReason || body.failure_reason || ""),
    }, {
      status: target.status,
      paymentStatus: target.payment_status,
      failureReason: target.failure_reason,
      assignedCourierId: target.assigned_courier_id,
      assignedCourierName: target.assigned_courier_name,
      assignedAt: target.assigned_at,
      acceptedAt: target.accepted_at,
      onRouteAt: target.on_route_at,
      deliveredAt: target.delivered_at,
      failedAt: target.failed_at,
      lastAssignmentAttemptAt: target.last_assignment_attempt_at,
      lastAssignmentError: target.last_assignment_error,
      paymentMethod: target.payment_method,
    });
    rebalancePackages();
    if (nextStatus === DELIVERED_STATUS) {
      const deliveredPackage = getPackageById(statusMatch[1]);
      updatePlatformOrderStatusByPackage(deliveredPackage || target, "completed");
      if (isPlatformBackedPackage(target)) {
        await notifyPlatformOrderDelivered(target.source_platform, target.external_order_id || target.external_order_no, deliveredPackage);
      }
    }
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_status_changed",
      packageId: statusMatch[1],
      restaurantId: target.restaurant_id,
      details: {
        from: currentStatus,
        to: nextStatus,
      },
    });
    broadcastLiveEvent({
      type: "package-status",
      restaurantId: target.restaurant_id,
      courierId: target.assigned_courier_id || null,
      message: `Paket durumu ${nextStatus} olarak guncellendi.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const reassignMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/reassign$/);
  if (req.method === "POST" && reassignMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Yeniden atama limiti asildi." });
      return;
    }

    const state = currentState();
    const target = state.packages.find((item) => item.id === reassignMatch[1]);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    if ([PENDING_APPROVAL_STATUS, REJECTED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(normalizeStatus(target.status))) {
      sendJson(res, 400, { error: "Bu durumdaki paket yeniden havuza alinamaz." });
      return;
    }

    const previousCourierId = target.assignedCourierId || null;
    // An explicit admin reassignment starts a fresh round, but the current courier
    // must never immediately receive the same package again.
    const excludedCourierIds = normalizeIdList([previousCourierId]);
    const reassignment = assignPackage(state, target, new Map(), { excludedCourierIds });
    persistPackageAssignment(reassignment);
    const reassignedPackage = getPackageById(target.id);
    setPackageTriedCouriers(target.id, normalizeIdList([
      ...excludedCourierIds,
      reassignedPackage?.assignedCourierId,
    ]));
    // Release the previous courier immediately and keep every panel's courier
    // status consistent with the newly persisted assignment.
    syncCourierOperationalStatuses(currentState());
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_reassigned",
      packageId: target.id,
      restaurantId: target.restaurantId,
      details: {
        status: target.status,
        previousCourierId,
        assignedCourierId: reassignedPackage?.assignedCourierId || null,
      },
    });
    broadcastLiveEvent({
      type: "package-reassign",
      packageId: target.id,
      restaurantId: target.restaurantId,
      courierId: reassignedPackage?.assignedCourierId || null,
      message: "Paket yeniden otomatik atama havuzuna alindi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const overrideMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/override$/);
  if (req.method === "POST" && overrideMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const courierId = trimmed(body.courierId || body.courier_id);
    if (!courierId) {
      sendJson(res, 400, { error: "courierId zorunludur." });
      return;
    }

    const result = adminAssignPackageToCourier(overrideMatch[1], courierId);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_override_assigned",
      packageId: overrideMatch[1],
      details: result,
    });
    broadcastLiveEvent({
      type: "package-override",
      packageId: overrideMatch[1],
      restaurantId: result.restaurantId,
      courierId: result.courierId,
      message: "Admin belirli paketi kuriyeye atadi.",
    });
    if (result.previousCourierId && result.previousCourierId !== result.courierId) {
      broadcastLiveEvent({
        type: "package-unassign",
        packageId: overrideMatch[1],
        restaurantId: result.restaurantId,
        courierId: result.previousCourierId,
        message: "Admin paketi baska bir kuryeye aktardi.",
      });
    }
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const unassignMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/unassign$/);
  if (req.method === "POST" && unassignMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const result = adminUnassignPackage(unassignMatch[1]);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_unassigned",
      packageId: unassignMatch[1],
      details: result,
    });
    broadcastLiveEvent({
      type: "package-unassign",
      packageId: result.packageId,
      restaurantId: result.restaurantId,
      courierId: result.previousCourierId,
      message: "Paketin kurye atamasi kaldirildi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  notFound(res);
}

const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  const incomingRequestId = trimmed(req.headers["x-request-id"] || req.headers["x-correlation-id"]).slice(0, 80);
  const requestId = incomingRequestId || uid("req");
  req.requestId = requestId;
  res._deliveraRequestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    recordRequestMetrics(requestStartedAt, res.statusCode || 0);
    recordRequestLog(req, res, requestStartedAt);
  });
  try {
    res._deliveraRequest = req;
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = requestUrl;

    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      if (!originForCors(req)) {
        sendJson(res, 403, { error: "CORS origin not allowed." });
        return;
      }
      writeSecurityHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        app: "RESTOMAP",
        timestamp: nowIso(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/ready") {
      const readiness = readinessPayload();
      sendJson(res, readiness.ok ? 200 : 503, readiness);
      return;
    }

    if (req.method === "GET" && pathname === "/metrics") {
      const suppliedMetricsToken = getBearerToken(req) || trimmed(req.headers["x-metrics-token"]);
      if ((IS_PRODUCTION || METRICS_TOKEN) && !timingSafeStringEqual(suppliedMetricsToken, METRICS_TOKEN)) {
        sendJson(res, METRICS_TOKEN ? 401 : 404, { error: METRICS_TOKEN ? "Metrics token gecersiz." : "Bulunamadi." });
        return;
      }
      sendText(res, 200, metricsTextPayload(), "text/plain; version=0.0.4; charset=utf-8");
      return;
    }

    const curtainControlMatch = pathname.match(/^\/_delivera-control\/([^/]+)$/);
    if (req.method === "GET" && curtainControlMatch) {
      let suppliedToken = "";
      try {
        suppliedToken = decodeURIComponent(curtainControlMatch[1]);
      } catch {}
      if (!systemCurtainControlTokenIsValid(suppliedToken)) {
        notFound(res);
        return;
      }
      sendFile(res, "system-curtain-control.html");
      return;
    }

    const createEndpointPath = ["/restaurants", "/couriers", "/packages", "/platform-orders"].includes(pathname);
    if (pathname.startsWith("/api/") || (req.method === "POST" && createEndpointPath)) {
      await handleApi(req, res, pathname);
      return;
    }

    const staticFile = findStaticFile(pathname, req.method);
    if (staticFile) {
      sendFile(res, staticFile);
      return;
    }

    notFound(res);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const logPayload = {
      endpoint: (() => {
        try {
          return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
        } catch {
          return req.url || "";
        }
      })(),
      method: req.method,
      requestId,
      statusCode,
      error,
    };
    if (statusCode >= 500) {
      logger.error("Unhandled request error", logPayload);
    } else if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      logger.warn("Request rejected", logPayload);
    }
    sendJson(res, statusCode, { error: error.message || "Bilinmeyen sunucu hatasi." });
  }
});

setInterval(() => {
  try {
    retryAwaitingAssignmentPackages();
  } catch (error) {
    logger.warn("Assignment retry sweep failed", { error });
    // Retry sweep should not crash the server loop.
  }
}, ASSIGNMENT_RETRY_INTERVAL_MS).unref();

setInterval(() => {
  triggerPosentegraOutbox();
}, Math.max(5_000, Number(process.env.POSENTEGRA_OUTBOX_POLL_MS || 10_000))).unref();

setInterval(() => {
  syncPosentegraInboundStatuses().catch((error) => {
    logger.warn("Posentegra inbound status sweep failed", { error });
  });
}, POSENTEGRA_INBOUND_SYNC_INTERVAL_MS).unref();

connectionHealthService = createConnectionHealthService({
  db,
  logger,
  platformAccountMissingCredentials,
  providerHealthUrlForAccount,
});

platformService = createPlatformService({
  getPlatformAccounts,
  findPlatformRestaurant,
  handleSimplePlatformOrder,
  normalizeOrder,
  connectorForPlatform,
  platformAccountMissingCredentials,
  nowIso,
  db,
  log: logger,
});

if (PLATFORM_POLLING_ENABLED) {
  setInterval(() => {
    platformService.pollAllPlatformAccounts().catch((error) => {
      logger.error("Platform polling failed", { error });
    });
  }, PLATFORM_POLL_INTERVAL_MS).unref();
} else {
  logger.info("Platform polling disabled; webhook flow is active.");
  logger.info("Polling skipped because global disabled");
}

currentState().packages
  .filter((pkg) => normalizeStatus(pkg.status) === ASSIGNED_STATUS)
  .forEach((pkg) => syncAssignmentRetryForPackage(pkg));

const telegramService = createTelegramService({ logger });

function operationsSupervisorSnapshot() {
  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE status IN (?, ?, ?, ?, ?, ?, ?)
    ORDER BY datetime(created_at) DESC
  `).all(
    PENDING_STATUS,
    PREPARING_STATUS,
    AWAITING_ASSIGNMENT_STATUS,
    FAILED_STATUS,
    ASSIGNED_STATUS,
    ACCEPTED_BY_COURIER_STATUS,
    ON_ROUTE_STATUS
  );
  const restaurantMap = new Map(getRestaurants().map((restaurant) => [restaurant.id, restaurant.name]));
  return {
    packages: rows.map((row) => mapPackageRow(row, restaurantMap, null)),
    couriers: getCouriers(),
  };
}

function operationsDailySummary(reportDate) {
  const start = new Date(`${reportDate}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS cancelled
    FROM packages
    WHERE created_at >= ? AND created_at < ?
  `).get(DELIVERED_STATUS, CANCELED_STATUS, REJECTED_STATUS, start.toISOString(), end.toISOString());
  const live = operationsSupervisorSnapshot();
  return {
    total: Number(counts.total || 0),
    delivered: Number(counts.delivered || 0),
    cancelled: Number(counts.cancelled || 0),
    active: live.packages.filter((pkg) => [ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(pkg.status)).length,
    waiting: live.packages.filter((pkg) => [PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, FAILED_STATUS].includes(pkg.status) && !pkg.assignedCourierId).length,
    onlineCouriers: live.couriers.filter((courier) => ["online", "busy"].includes(courier.status)).length,
  };
}

function operationsIstanbulDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function operationsMinutesBetween(from, to) {
  const fromMs = new Date(from || "").getTime();
  const toMs = new Date(to || "").getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null;
  return (toMs - fromMs) / 60_000;
}

function operationsAnalyticsSnapshot(requestedDays = 7) {
  const days = Math.max(1, Math.min(31, Number(requestedDays) || 7));
  const nowDate = new Date();
  const since = new Date(nowDate.getTime() - (days + 1) * 24 * 60 * 60 * 1000).toISOString();
  // Bu sorgu yalnız analiz içindir; paket, atama veya platform durumunu değiştirmez.
  const rows = db.prepare(`
    SELECT id, restaurant_id, assigned_courier_id, assigned_courier_name, status,
           created_at, assigned_at, delivered_at
    FROM packages
    WHERE created_at >= ?
    ORDER BY datetime(created_at) DESC
  `).all(since);
  const restaurantNames = new Map(getRestaurants().map((restaurant) => [restaurant.id, restaurant.name]));
  const courierNames = new Map(getCouriers().map((courier) => [courier.id, courier.name]));
  const today = operationsIstanbulDateKey(nowDate);
  const acceptedDates = new Set();
  for (let index = 0; index < days; index += 1) {
    acceptedDates.add(operationsIstanbulDateKey(new Date(nowDate.getTime() - index * 24 * 60 * 60 * 1000)));
  }
  const selected = rows.filter((row) => acceptedDates.has(operationsIstanbulDateKey(row.created_at)));
  const dailyMap = new Map([...acceptedDates].map((date) => [date, { date, total: 0, delivered: 0, cancelled: 0 }]));
  const restaurantMap = new Map();
  const courierMap = new Map();
  const assignmentMinutes = [];
  const deliveryMinutes = [];
  let delivered = 0;
  let cancelled = 0;

  for (const row of selected) {
    const status = normalizeStatus(row.status);
    const dateKey = operationsIstanbulDateKey(row.created_at);
    const daily = dailyMap.get(dateKey);
    daily.total += 1;
    if (status === DELIVERED_STATUS) daily.delivered += 1;
    if ([CANCELED_STATUS, REJECTED_STATUS].includes(status)) daily.cancelled += 1;
    if (status === DELIVERED_STATUS) delivered += 1;
    if ([CANCELED_STATUS, REJECTED_STATUS].includes(status)) cancelled += 1;

    const assignmentDuration = operationsMinutesBetween(row.created_at, row.assigned_at);
    const deliveryDuration = operationsMinutesBetween(row.created_at, row.delivered_at);
    if (assignmentDuration !== null) assignmentMinutes.push(assignmentDuration);
    if (deliveryDuration !== null) deliveryMinutes.push(deliveryDuration);

    const restaurantId = row.restaurant_id || "unknown";
    const restaurant = restaurantMap.get(restaurantId) || {
      id: restaurantId,
      name: restaurantNames.get(restaurantId) || "Bilinmeyen Restoran",
      total: 0,
      delivered: 0,
      cancelled: 0,
    };
    restaurant.total += 1;
    if (status === DELIVERED_STATUS) restaurant.delivered += 1;
    if ([CANCELED_STATUS, REJECTED_STATUS].includes(status)) restaurant.cancelled += 1;
    restaurantMap.set(restaurantId, restaurant);

    if (row.assigned_courier_id) {
      const courier = courierMap.get(row.assigned_courier_id) || {
        id: row.assigned_courier_id,
        name: row.assigned_courier_name || courierNames.get(row.assigned_courier_id) || row.assigned_courier_id,
        total: 0,
        delivered: 0,
      };
      courier.total += 1;
      if (status === DELIVERED_STATUS) courier.delivered += 1;
      courierMap.set(courier.id, courier);
    }
  }

  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const priorDays = daily.filter((item) => item.date !== today);
  const priorAverage = average(priorDays.map((item) => item.total));
  const todaySoFar = dailyMap.get(today)?.total || 0;
  const localHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(nowDate).split(":")[0] || 0);
  const elapsedRatio = Math.max(1 / 24, (localHour + 1) / 24);
  const expectedSoFar = priorAverage * elapsedRatio;

  return {
    periodDays: days,
    totals: {
      total: selected.length,
      delivered,
      cancelled,
      deliveryRate: selected.length ? delivered * 100 / selected.length : 0,
      avgAssignmentMinutes: average(assignmentMinutes),
      avgDeliveryMinutes: average(deliveryMinutes),
    },
    daily,
    restaurants: [...restaurantMap.values()].sort((a, b) => b.total - a.total),
    couriers: [...courierMap.values()].sort((a, b) => b.delivered - a.delivered || b.total - a.total),
    forecast: {
      expectedToday: Math.max(todaySoFar, priorAverage),
      todaySoFar,
      changePercent: expectedSoFar > 0 ? (todaySoFar - expectedSoFar) * 100 / expectedSoFar : 0,
    },
  };
}

function operationsFindPackage(reference) {
  const needle = trimmed(reference);
  if (!needle) return null;
  const row = db.prepare(`
    SELECT * FROM packages
    WHERE LOWER(id) = LOWER(?)
       OR LOWER(tracking_no) = LOWER(?)
       OR LOWER(COALESCE(external_order_no, '')) = LOWER(?)
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(needle, needle, needle);
  if (!row) return null;
  const restaurantMap = new Map(getRestaurants().map((restaurant) => [restaurant.id, restaurant.name]));
  return mapPackageRow(row, restaurantMap, null);
}

async function operationsRetryPackage(reference) {
  const pkg = operationsFindPackage(reference);
  if (!pkg) return { ok: false, message: `${reference} bulunamadı.` };
  const status = normalizeStatus(pkg.status);
  if ([DELIVERED_STATUS, CANCELED_STATUS, REJECTED_STATUS].includes(status)) {
    return { ok: false, message: `${packageLabelForLog(pkg)} terminal durumda (${status}); değiştirilmedi.` };
  }
  if ([ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(status)) {
    return { ok: false, message: `${packageLabelForLog(pkg)} zaten ${status} durumunda; ataması değiştirilmedi.` };
  }
  if (![PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, FAILED_STATUS].includes(status)) {
    return { ok: false, message: `${packageLabelForLog(pkg)} için tekrar deneme güvenli değil (${status}).` };
  }
  await rebalancePackages();
  const updated = operationsFindPackage(reference);
  return {
    ok: true,
    message: `${packageLabelForLog(updated || pkg)} için mevcut güvenli atama motoru çalıştırıldı. Güncel durum: ${updated?.status || status}.`,
  };
}

function packageLabelForLog(pkg) {
  return pkg?.trackingNo || pkg?.externalOrderNo || pkg?.id || "Paket";
}

const operationsSupervisor = createOperationsSupervisor({
  getSnapshot: () => operationsSupervisorSnapshot(),
  getDailySummary: (reportDate) => operationsDailySummary(reportDate),
  getHealthSnapshot: () => systemStatusPayload(),
  getAnalyticsSnapshot: (days) => operationsAnalyticsSnapshot(days),
  findPackage: (reference) => operationsFindPackage(reference),
  retryPackage: (reference) => operationsRetryPackage(reference),
  rebalance: () => rebalancePackages(),
  recordAction: (entry) => writeAuditLog({
    actorRole: "operations_bot",
    actorId: "telegram_supervisor",
    action: entry.action,
    packageId: entry.details?.packageId || null,
    restaurantId: entry.details?.restaurantId || null,
    details: entry.details || {},
  }),
  telegram: telegramService,
  logger,
});
operationsSupervisor.start();

server.listen(PORT, () => {
  logger.info("RESTOMAP ready", { url: `http://localhost:${PORT}`, port: PORT });
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Graceful shutdown started", { signal });
  const forceTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out", { signal });
    process.exit(1);
  }, 15_000);
  forceTimer.unref();
  operationsSupervisor.stop();
  liveStreams.forEach((stream) => closeLiveStream(stream.id));
  server.close(async () => {
    try {
      await queueService.close();
      dbFacade.close();
      logger.info("Graceful shutdown completed", { signal });
      process.exit(0);
    } catch (error) {
      logger.error("Graceful shutdown failed", { signal, error });
      process.exit(1);
    }
  });
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));
