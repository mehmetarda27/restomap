const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { databaseEnvInfo, databaseUrl, postgresRequired } = require("./config");

const ROOT = path.resolve(__dirname, "..");
let connection = null;
let connectionFile = "";
let activeAdapter = null;
let databaseDecisionLogged = false;

let pgWorker = null;
let pgSab = null;
let pgSabInts = null;
let pgSabBuffer = null;

function isProduction() {
  return postgresRequired();
}

function hasPostgresUrl() {
  return Boolean(databaseUrl());
}

function logDatabaseDecision(client, reason = "") {
  if (databaseDecisionLogged) {
    return;
  }
  databaseDecisionLogged = true;
  const info = databaseEnvInfo();
  const payload = {
    client,
    reason,
    postgresUrlConfigured: info.configured,
    postgresEnvName: info.variable,
    postgresUrlSource: info.source,
    detectedPostgresEnvNames: info.detectedVariables,
    supportedPostgresEnvNames: info.supportedVariables,
    postgresRequired: info.postgresRequired,
    nodeEnv: info.nodeEnv,
    renderDetected: info.renderDetected,
    renderEnvNames: info.renderVariables,
    cwd: info.cwd,
    skipReason: info.skipReason,
  };
  const line = `[database_init] ${JSON.stringify(payload)}`;
  if (client === "postgres") {
    console.info(line);
  } else if (info.postgresRequired) {
    console.error(line);
  } else {
    console.warn(line);
  }
}

function resolveDbFile() {
  if (clientName() === "postgres") {
    return "postgresql";
  }

  const configured = process.env.DATABASE_PATH || process.env.DB_PATH || process.env.DELIVERA_DB_FILE;
  if (!configured) {
    const currentDbFile = path.join(ROOT, "restomap.sqlite");
    const legacyDbFile = path.join(ROOT, "delivera.sqlite");
    return fs.existsSync(currentDbFile) || !fs.existsSync(legacyDbFile) ? currentDbFile : legacyDbFile;
  }

  if (path.isAbsolute(configured)) {
    return configured;
  }

  // Relative DB paths must stay under the project root regardless of process cwd.
  return path.join(ROOT, configured.replace(/^\.[\\/]/, ""));
}

function clientName() {
  if (hasPostgresUrl()) {
    logDatabaseDecision("postgres", "supported_postgres_connection_string_env_detected");
    return "postgres";
  }

  if (isProduction()) {
    const info = databaseEnvInfo();
    logDatabaseDecision("none", info.skipReason);
    throw new Error(
      `PostgreSQL connection string is required in production/Render. ` +
      `Checked env vars: ${info.supportedVariables.join(", ")}. ` +
      `Detected postgres env vars: ${info.detectedVariables.join(", ") || "none"}. ` +
      `Render detected: ${info.renderDetected}. NODE_ENV=${info.nodeEnv || "(empty)"}. SQLite is disabled.`
    );
  }

  const configured = String(process.env.DATABASE_CLIENT || process.env.DB_CLIENT || process.env.DB_ADAPTER || process.env.DATABASE_ADAPTER || "sqlite").toLowerCase();
  const client = configured === "postgresql" ? "postgres" : configured;
  logDatabaseDecision(client, "no_postgres_env_local_fallback");
  return client;
}

function adapterName() {
  return clientName();
}

function getWorker() {
  if (pgWorker) return pgWorker;

  const hasPostgres = clientName() === "postgres";
  const hasRedis = Boolean(process.env.REDIS_URL || process.env.DELIVERA_REDIS_URL);
  
  if (!hasPostgres && !hasRedis) {
    return null;
  }

  // Allocate adequate shared memory (dynamically sized, minimum 16MB)
  const MIN_SAB_SIZE = 16 * 1024 * 1024; // 16MB minimum
  const MAX_SAB_SIZE = 256 * 1024 * 1024; // 256MB maximum
  const configuredSize = Math.max(
    MIN_SAB_SIZE,
    Math.min(MAX_SAB_SIZE, Number(process.env.DELIVERA_SAB_SIZE) || MIN_SAB_SIZE)
  );
  
  pgSab = new SharedArrayBuffer(configuredSize);
  pgSabInts = new Int32Array(pgSab);
  pgSabBuffer = new Uint8Array(pgSab);

  Atomics.store(pgSabInts, 0, 0);

  const workerPath = path.resolve(__dirname, "..", "scripts", "pg-worker.js");
  pgWorker = new Worker(workerPath, {
    workerData: { sab: pgSab },
    env: process.env,
  });

  pgWorker.on("error", (err) => {
    // suppress worker error to avoid crashing server on startup
  });

  return pgWorker;
}

function sendWorkerRequest(req) {
  const worker = getWorker();
  if (!worker) {
    throw new Error("Worker thread is not running. Check database/Redis configuration.");
  }
  
  let reqStr;
  try {
    reqStr = JSON.stringify(req);
  } catch (error) {
    throw new Error(`Failed to serialize request: ${error.message}`);
  }
  
  const reqBytes = Buffer.from(reqStr, "utf8");
  const maxRequestSize = pgSabBuffer.length - 8;
  
  if (reqBytes.length > maxRequestSize) {
    throw new Error(
      `Request size (${reqBytes.length} bytes) exceeds maximum (${maxRequestSize} bytes). ` +
      `Consider breaking into smaller chunks or increasing DELIVERA_SAB_SIZE environment variable.`
    );
  }
  
  pgSabInts[1] = reqBytes.length;
  reqBytes.copy(pgSabBuffer, 8);
  
  Atomics.store(pgSabInts, 0, 1);
  worker.postMessage("run");
  
  // Wait for worker response with timeout
  const WAIT_TIMEOUT_MS = Number(process.env.DELIVERA_DB_WORKER_TIMEOUT_MS || 30000);
  const startTime = Date.now();
  
  while (true) {
    const status = Atomics.load(pgSabInts, 0);
    if (status === 2 || status === 3) {
      break;
    }
    
    const elapsed = Date.now() - startTime;
    if (elapsed > WAIT_TIMEOUT_MS) {
      throw new Error(`Worker request timeout (${WAIT_TIMEOUT_MS}ms exceeded)`);
    }
    
    const remaining = Math.min(1000, WAIT_TIMEOUT_MS - elapsed);
    Atomics.wait(pgSabInts, 0, status, remaining);
  }
  
  const status = Atomics.load(pgSabInts, 0);
  const resLength = pgSabInts[1];
  
  // Validate response length
  if (resLength < 0 || resLength > pgSabBuffer.length - 8) {
    throw new Error(`Invalid response length: ${resLength}`);
  }
  
  const resBytes = Buffer.from(pgSab, 8, resLength);
  
  let resStr;
  try {
    resStr = resBytes.toString("utf8");
  } catch (error) {
    throw new Error(`Failed to decode response: ${error.message}`);
  }
  
  Atomics.store(pgSabInts, 0, 0);
  
  let parsed;
  try {
    parsed = JSON.parse(resStr);
  } catch (error) {
    throw new Error(
      `Worker returned invalid JSON response: ${error.message}. ` +
      `Response (first 500 chars): ${resStr.substring(0, 500)}`
    );
  }
  
  if (!parsed.ok) {
    const error = new Error(parsed.error || "Unknown worker thread error");
    if (parsed.stack) {
      error.stack = parsed.stack;
    }
    throw error;
  }
  
  return parsed.data;
}

const redisSync = {
  get(key) {
    try {
      const res = sendWorkerRequest({ type: "redis", cmd: "get", key });
      return res.data;
    } catch {
      return null;
    }
  },
  set(key, val, ttl) {
    try {
      sendWorkerRequest({ type: "redis", cmd: "set", key, val, ttl });
      return true;
    } catch {
      return false;
    }
  },
  del(key) {
    try {
      sendWorkerRequest({ type: "redis", cmd: "del", key });
      return true;
    } catch {
      return false;
    }
  }
};

function createSqliteAdapter() {
  return {
    name: "sqlite",
    getDb(options = {}) {
      const { DatabaseSync } = require("node:sqlite");
      const filename = path.resolve(options.filename || resolveDbFile());
      if (connection && connectionFile === filename) {
        return connection;
      }
      if (connection) {
        close();
      }

      fs.mkdirSync(path.dirname(filename), { recursive: true });
      connection = new DatabaseSync(filename);
      connectionFile = filename;
      connection.exec("PRAGMA foreign_keys = ON");
      return connection;
    },
    run(sql, params = []) {
      return this.getDb().prepare(sql).run(...params);
    },
    get(sql, params = []) {
      return this.getDb().prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return this.getDb().prepare(sql).all(...params);
    },
    transaction(callback) {
      const db = this.getDb();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = callback(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
    close,
  };
}

function createPostgresAdapter() {
  // Ensure worker is running
  try {
    getWorker();
  } catch (error) {
    console.error("[database_init] PostgreSQL worker initialization failed", error);
    throw error;
  }

  return {
    name: "postgres",
    getDb() {
      // Mock db object that mimics DatabaseSync interface
      return {
        prepare: (sql) => {
          return {
            run: (...params) => this.run(sql, params),
            all: (...params) => this.all(sql, params),
            get: (...params) => this.get(sql, params),
          };
        },
        exec: (sql) => {
          this.run(sql);
        },
        close: () => {},
      };
    },
    run(sql, params = []) {
      // Intercept metadata schema checks
      if (sql.trim().toUpperCase().startsWith("PRAGMA TABLE_INFO(")) {
        const match = sql.match(/PRAGMA\s+table_info\s*\(\s*["']?(\w+)["']?\s*\)/i);
        if (match) {
          const tableName = match[1].toLowerCase();
          const res = sendWorkerRequest({
            type: "db",
            sql: `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`,
            params: [tableName]
          });
          return res.rows;
        }
      }

      if (sql.includes("sqlite_master")) {
        const res = sendWorkerRequest({
          type: "db",
          sql: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`,
          params: params
        });
        return res.rows[0] || null;
      }

      const res = sendWorkerRequest({ type: "db", sql, params });
      return { changes: res.rowCount };
    },
    get(sql, params = []) {
      if (sql.includes("sqlite_master")) {
        const res = sendWorkerRequest({
          type: "db",
          sql: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`,
          params: params
        });
        return res.rows[0] || null;
      }

      const res = sendWorkerRequest({ type: "db", sql, params });
      return res.rows[0] || null;
    },
    all(sql, params = []) {
      if (sql.trim().toUpperCase().startsWith("PRAGMA TABLE_INFO(")) {
        const match = sql.match(/PRAGMA\s+table_info\s*\(\s*["']?(\w+)["']?\s*\)/i);
        if (match) {
          const tableName = match[1].toLowerCase();
          const res = sendWorkerRequest({
            type: "db",
            sql: `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`,
            params: [tableName]
          });
          return res.rows;
        }
      }

      const res = sendWorkerRequest({ type: "db", sql, params });
      return res.rows;
    },
    transaction(callback) {
      sendWorkerRequest({ type: "db", sql: "BEGIN" });
      try {
        const result = callback(this.getDb());
        sendWorkerRequest({ type: "db", sql: "COMMIT" });
        return result;
      } catch (error) {
        try {
          sendWorkerRequest({ type: "db", sql: "ROLLBACK" });
        } catch {}
        throw error;
      }
    },
    close() {},
  };
}

function createAdapter() {
  const client = clientName();
  if (client === "sqlite") {
    return createSqliteAdapter();
  }
  if (client === "postgres") {
    return createPostgresAdapter();
  }
  throw new Error(`DATABASE_CLIENT '${client}' desteklenmiyor. Gecerli degerler: sqlite, postgres.`);
}

function adapter() {
  const client = clientName();
  const normalizedClient = client === "postgresql" ? "postgres" : client;
  if (!activeAdapter || activeAdapter.name !== normalizedClient) {
    activeAdapter = createAdapter();
  }
  return activeAdapter;
}

function getDb(options = {}) {
  return adapter().getDb(options);
}

function run(sql, params = []) {
  return adapter().run(sql, params);
}

function get(sql, params = []) {
  return adapter().get(sql, params);
}

function all(sql, params = []) {
  return adapter().all(sql, params);
}

function transaction(callback) {
  return adapter().transaction(callback);
}

function poolStatus() {
  if (clientName() !== "postgres") {
    return {
      adapter: "sqlite",
      enabled: false,
    };
  }

  try {
    return {
      adapter: "postgres",
      enabled: true,
      ...sendWorkerRequest({ type: "pgPoolStatus" }),
    };
  } catch (error) {
    return {
      adapter: "postgres",
      enabled: true,
      error: error.message,
    };
  }
}

function close() {
  if (connection) {
    connection.close();
    connection = null;
    connectionFile = "";
  }
  if (pgWorker) {
    pgWorker.terminate();
    pgWorker = null;
    pgSab = null;
    pgSabInts = null;
    pgSabBuffer = null;
  }
  activeAdapter = null;
}

module.exports = {
  adapterName,
  all,
  clientName,
  close,
  databaseEnvInfo,
  databaseUrl,
  get,
  getDb,
  poolStatus,
  resolveDbFile,
  run,
  transaction,
  redisSync,
};
