try {
  require("dotenv").config({ path: "./.env" });
} catch {}

require("../services/envCompatibility").applyBrandEnvCompatibility();

const { Worker, QueueEvents } = require("bullmq");
const dbFacade = require("../db");
const { getDb, close } = dbFacade;
const logger = require("../services/logger");
const { JOB_TYPES, DEFAULT_RETRY_POLICY } = require("../services/queueService");
const { redisConnectionOptions } = require("../services/redisConnection");
const { sendPlatformStatusCallback } = require("../services/platformCallbackService");
const posentegraClient = require("../services/posentegraClient");
const { createPosentegraOutboxService } = require("../services/posentegraOutboxService");

const REDIS_URL = String(process.env.REDIS_URL || process.env.DELIVERA_REDIS_URL || "").trim();
const QUEUE_CONCURRENCY = Number(process.env.DELIVERA_WORKER_CONCURRENCY || 5);
const connection = redisConnectionOptions(REDIS_URL);
const workers = [];
const queueEvents = [];
const db = getDb();
const posentegraOutbox = createPosentegraOutboxService({ db, client: posentegraClient, logger });
let posentegraSweepTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function mapPackageRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    externalOrderId: row.external_order_id,
    assignedCourierId: row.assigned_courier_id,
    platformStatusLogs: parseJson(row.platform_status_logs_json, []),
  };
}

function appendPlatformStatusLog(packageId, entry) {
  const target = db.prepare("SELECT platform_status_logs_json FROM packages WHERE id = ?").get(packageId);
  if (!target) {
    return;
  }
  const logs = parseJson(target.platform_status_logs_json, []);
  logs.push({
    id: `plog_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    status: entry.status,
    message: entry.message,
    platform: entry.platform,
    createdAt: nowIso(),
    meta: entry.meta || {},
  });
  db.prepare("UPDATE packages SET platform_status_logs_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(logs),
    nowIso(),
    packageId
  );
}

function updateWebhookRetryState(webhookLogId, fields = {}) {
  if (!webhookLogId) {
    return;
  }
  db.prepare(`
    UPDATE webhook_logs
    SET retry_count = COALESCE(?, retry_count),
        next_retry_at = COALESCE(?, next_retry_at),
        dead_lettered_at = COALESCE(?, dead_lettered_at),
        last_error = COALESCE(?, last_error)
    WHERE id = ?
  `).run(
    fields.retryCount ?? null,
    fields.nextRetryAt ?? null,
    fields.deadLetteredAt ?? null,
    fields.lastError ?? null,
    webhookLogId
  );
}

async function processStatusCallbackJob(job) {
  const data = job.data || {};
  const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(data.packageId);
  const packageRecord = mapPackageRow(row);
  if (!packageRecord) {
    updateWebhookRetryState(data.webhookLogId, {
      retryCount: job.attemptsMade + 1,
      lastError: "package_not_found",
    });
    throw new Error("package_not_found");
  }

  const result = await sendPlatformStatusCallback({
    db,
    packageRecord,
    status: data.status,
    meta: data.meta || data.orderData || {},
  });
  appendPlatformStatusLog(packageRecord.id, {
    status: data.status,
    message: result.ok ? "platform callback retry succeeded" : `platform callback retry failed: ${result.error || result.status}`,
    platform: packageRecord.sourcePlatform,
    meta: { workerJobId: job.id, mode: result.mode, status: result.status },
  });

  if (!result.ok) {
    const nextRetryAt = new Date(Date.now() + DEFAULT_RETRY_POLICY.backoff.delayMs * Math.max(1, job.attemptsMade + 1)).toISOString();
    updateWebhookRetryState(data.webhookLogId, {
      retryCount: job.attemptsMade + 1,
      nextRetryAt,
      lastError: result.error || `callback_${result.status}`,
    });
    throw new Error(result.error || `callback_${result.status}`);
  }

  updateWebhookRetryState(data.webhookLogId, {
    retryCount: job.attemptsMade + 1,
    nextRetryAt: "",
    lastError: "",
  });
  return result;
}

async function processAssignmentRetryJob(job) {
  const packageId = job.data?.packageId;
  if (!packageId) {
    throw new Error("packageId_required");
  }
  db.prepare(`
    UPDATE packages
    SET last_assignment_attempt_at = ?, last_assignment_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), packageId);
  return { ok: true, packageId };
}

async function processPlatformStatusSyncJob(job) {
  const packageId = job.data?.packageId;
  const status = job.data?.status;
  const row = packageId ? db.prepare("SELECT posentegra_id FROM packages WHERE id = ?").get(packageId) : null;
  if (!packageId || !status || !row?.posentegra_id) {
    throw new Error("posentegra_status_sync_payload_invalid");
  }
  posentegraOutbox.enqueueStatus({ packageId, orderId: row.posentegra_id, status, meta: job.data?.meta || {} });
  return posentegraOutbox.processDue();
}

function processorFor(type) {
  if (type === JOB_TYPES.ASSIGNMENT_RETRY) {
    return processAssignmentRetryJob;
  }
  if (type === JOB_TYPES.PLATFORM_STATUS_SYNC) {
    return processPlatformStatusSyncJob;
  }
  return processStatusCallbackJob;
}

function startWorker(type) {
  const worker = new Worker(type, processorFor(type), {
    connection,
    concurrency: QUEUE_CONCURRENCY,
  });
  const events = new QueueEvents(type, { connection });

  worker.on("completed", (job) => {
    logger.info("Queue job completed", { type, jobId: job.id, attemptsMade: job.attemptsMade });
  });
  worker.on("failed", (job, error) => {
    const attemptsMade = job?.attemptsMade || 0;
    const maxAttempts = job?.opts?.attempts || DEFAULT_RETRY_POLICY.attempts;
    const deadLettered = attemptsMade >= maxAttempts;
    if (deadLettered) {
      updateWebhookRetryState(job?.data?.webhookLogId, {
        retryCount: attemptsMade,
        deadLetteredAt: nowIso(),
        lastError: error.message,
      });
    }
    logger.warn("Queue job failed", {
      type,
      jobId: job?.id,
      attemptsMade,
      maxAttempts,
      deadLettered,
      error: error.message,
    });
  });
  events.on("error", (error) => logger.warn("Queue events error", { type, error: error.message }));

  workers.push(worker);
  queueEvents.push(events);
}

async function shutdown() {
  if (posentegraSweepTimer) clearInterval(posentegraSweepTimer);
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await Promise.allSettled(queueEvents.map((events) => events.close()));
  close();
}

async function main() {
  if (!REDIS_URL) {
    logger.warn("Worker not started because REDIS_URL is not configured; application inline fallback remains active");
    return;
  }
  Object.values(JOB_TYPES).forEach(startWorker);
  posentegraSweepTimer = setInterval(() => {
    posentegraOutbox.processDue().catch((error) => logger.warn("Worker Posentegra outbox sweep failed", { error }));
  }, Math.max(5_000, Number(process.env.POSENTEGRA_OUTBOX_POLL_MS || 10_000)));
  posentegraSweepTimer.unref();
  posentegraOutbox.processDue().catch((error) => logger.warn("Initial Posentegra outbox sweep failed", { error }));
  logger.info("RESTOMAP queue worker started", {
    queues: Object.values(JOB_TYPES),
    concurrency: QUEUE_CONCURRENCY,
    retryPolicy: DEFAULT_RETRY_POLICY,
  });
}

process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));

main().catch((error) => {
  logger.error("Queue worker failed to start", { error });
  process.exitCode = 1;
});
