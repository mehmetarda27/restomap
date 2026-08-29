const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevel = LEVELS[configuredLevel] || LEVELS.info;

function shouldLog(level) {
  return (LEVELS[level] || LEVELS.info) >= activeLevel;
}

function serializeError(error) {
  if (!error) {
    return undefined;
  }
  return {
    name: error.name,
    message: error.message,
    stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
  };
}

const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.resolve(__dirname, "..", "logs");
const LOG_FILE = path.join(LOGS_DIR, "app.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUP_FILES = 5;

let isRotating = false;

function rotateLogs() {
  if (isRotating) return;
  isRotating = true;
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return;

    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
      const oldFile = path.join(LOGS_DIR, `app-${i}.log`);
      const newFile = path.join(LOGS_DIR, `app-${i + 1}.log`);
      if (fs.existsSync(oldFile)) {
        try {
          if (fs.existsSync(newFile)) {
            fs.unlinkSync(newFile);
          }
          fs.renameSync(oldFile, newFile);
        } catch {}
      }
    }

    const firstBackup = path.join(LOGS_DIR, "app-1.log");
    if (fs.existsSync(firstBackup)) {
      fs.unlinkSync(firstBackup);
    }
    fs.renameSync(LOG_FILE, firstBackup);
  } catch (err) {
    // ignore logger failures to not crash app
  } finally {
    isRotating = false;
  }
}

function writeToFile(line) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    rotateLogs();
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    // ignore
  }
}

function write(level, message, meta = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    service: "restomap",
    ...meta,
  };

  if (payload.error instanceof Error) {
    payload.error = serializeError(payload.error);
  }

  const line = JSON.stringify(payload);
  
  // Write to log file
  writeToFile(line);

  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

module.exports = {
  debug(message, meta) {
    write("debug", message, meta);
  },
  info(message, meta) {
    write("info", message, meta);
  },
  warn(message, meta) {
    write("warn", message, meta);
  },
  error(message, meta) {
    write("error", message, meta);
  },
  child(defaultMeta = {}) {
    return {
      debug(message, meta = {}) {
        write("debug", message, { ...defaultMeta, ...meta });
      },
      info(message, meta = {}) {
        write("info", message, { ...defaultMeta, ...meta });
      },
      warn(message, meta = {}) {
        write("warn", message, { ...defaultMeta, ...meta });
      },
      error(message, meta = {}) {
        write("error", message, { ...defaultMeta, ...meta });
      },
    };
  },
};
