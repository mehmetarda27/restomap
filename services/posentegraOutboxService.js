const crypto = require("crypto");

const EVENT_TYPES = Object.freeze({
  PACKAGE_ASSIGN: "package.assign",
  ORDER_STATUS: "order.status",
  ORDER_CANCEL: "order.cancel",
});

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function trimmed(value) {
  return String(value ?? "").trim();
}

function statusRank(status) {
  const normalized = trimmed(status).toLowerCase();
  if (normalized === "accepted") return 1;
  if (normalized === "on_the_way") return 2;
  if (normalized === "delivered" || normalized === "failed") return 3;
  return 99;
}

function remoteStatusCode(result) {
  const body = result?.responseBody || {};
  const order = body.data?.order || body.data || body.order || body;
  const value = order.statusCode ?? order.status_code ?? order.status?.code ?? order.status;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function remoteStatusRank(code) {
  // FastSiparis change-status advances one remote step at a time. Live orders
  // continue through 600/700/800 and are only terminally delivered at 900.
  // Cancellation remains the distinct 1600 terminal state.
  if (code === 900) return 3;
  if ([500, 600, 700, 800].includes(code)) return 2;
  if (code === 400) return 1;
  if ([100, 200, 300].includes(code)) return 0;
  return null;
}

function desiredStatusRank(status) {
  const normalized = trimmed(status).toLowerCase();
  if (["delivered", "completed"].includes(normalized)) return 3;
  if (["on_route", "on_the_way", "picked_up"].includes(normalized)) return 2;
  if (["accepted_by_courier", "accepted", "assigned"].includes(normalized)) return 1;
  return null;
}

function responseId(result) {
  const body = result?.responseBody || {};
  return trimmed(body.id || body.pid || body.orderId || body.order_id || body.data?.id || body.data?.pid);
}

function createPosentegraOutboxService({ db, client, logger, maxAttempts = 10 } = {}) {
  let processing = false;
  let rerunRequested = false;

  function enqueue(eventType, aggregateId, payload, dedupeKey) {
    const createdAt = nowIso();
    const id = `pob_${crypto.randomBytes(16).toString("hex")}`;
    db.prepare(`
      INSERT INTO posentegra_outbox (
        id, event_type, aggregate_id, dedupe_key, payload_json, status, attempts,
        next_attempt_at, last_error, locked_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        status = CASE
          WHEN posentegra_outbox.status IN ('completed', 'processing', 'dead_letter') THEN posentegra_outbox.status
          ELSE 'pending'
        END,
        next_attempt_at = CASE
          WHEN posentegra_outbox.status IN ('completed', 'processing', 'dead_letter') THEN posentegra_outbox.next_attempt_at
          ELSE excluded.next_attempt_at
        END,
        last_error = CASE
          WHEN posentegra_outbox.status IN ('completed', 'processing', 'dead_letter') THEN posentegra_outbox.last_error
          ELSE NULL
        END,
        locked_at = CASE WHEN posentegra_outbox.status = 'processing' THEN posentegra_outbox.locked_at ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(id, eventType, aggregateId, dedupeKey, JSON.stringify(payload || {}), createdAt, createdAt, createdAt);
    return db.prepare("SELECT * FROM posentegra_outbox WHERE dedupe_key = ?").get(dedupeKey);
  }

  function enqueuePackageAssignment({ packageId, restaurantPosentegraId, packagePayload }) {
    if (!client.configured() || !trimmed(restaurantPosentegraId) || !trimmed(packageId)) {
      return null;
    }
    return enqueue(EVENT_TYPES.PACKAGE_ASSIGN, packageId, {
      restaurantPosentegraId,
      packagePayload: { ...packagePayload, id: packageId, packageId },
    }, `package.assign:${packageId}`);
  }

  function enqueueStatus({ packageId, orderId, status, meta = {} }) {
    if (!client.configured() || !trimmed(packageId) || !trimmed(orderId) || !trimmed(status)) {
      return null;
    }
    return enqueue(EVENT_TYPES.ORDER_STATUS, packageId, { orderId, status, meta }, `order.status:${packageId}:${status}`);
  }

  function enqueueCancellation({ packageId, orderId, reason, meta = {} }) {
    if (!client.configured() || !trimmed(packageId) || !trimmed(orderId)) {
      return null;
    }
    const cancellationNote = trimmed(reason) || "Restoran siparişi reddetti.";
    return enqueue(EVENT_TYPES.ORDER_CANCEL, packageId, {
      orderId,
      // FastSiparis sabit neden kodu bekler; insan açıklaması note alanında kalır.
      reason: "TECHNICAL_PROBLEM",
      meta: { ...meta, note: trimmed(meta.note) || cancellationNote },
    }, `order.cancel:${packageId}`);
  }

  async function advanceOrderToDelivered(orderId, meta = {}) {
    const allowedForwardCodes = new Set([100, 200, 300, 400, 500, 600, 700, 800]);
    const transitions = [];
    let remoteResult = await client.getOrder(orderId);
    let currentCode = remoteStatusCode(remoteResult);

    for (let step = 0; step < 10; step += 1) {
      if (currentCode === 900) {
        return { remoteResult, remoteCode: currentCode, transitions };
      }
      if (currentCode === 1600) {
        const error = new Error("Posentegra siparisi iptal durumda; teslim durumuna ilerletilemez.");
        error.statusCode = 409;
        throw error;
      }
      if (!allowedForwardCodes.has(currentCode)) {
        const error = new Error(`Posentegra teslim ilerlemesi guvenli degil (uzak durum: ${currentCode ?? "bilinmiyor"}).`);
        error.statusCode = 409;
        throw error;
      }

      const beforeCode = currentCode;
      await client.changeOrderStatus(orderId, "delivered", {
        ...meta,
        reconciliation: true,
        remoteBefore: beforeCode,
      });
      remoteResult = await client.getOrder(orderId);
      currentCode = remoteStatusCode(remoteResult);
      transitions.push({ from: beforeCode, to: currentCode });

      if (currentCode === 900) {
        return { remoteResult, remoteCode: currentCode, transitions };
      }
      if (!Number.isFinite(currentCode) || currentCode <= beforeCode) {
        const error = new Error(
          `Posentegra teslim ilerlemesi dogrulanamadi (once: ${beforeCode}, sonra: ${currentCode ?? "bilinmiyor"}).`
        );
        error.statusCode = 502;
        throw error;
      }
    }

    const error = new Error(`Posentegra teslim durumu 900 koduna ulasmadi (son durum: ${currentCode ?? "bilinmiyor"}).`);
    error.statusCode = 502;
    throw error;
  }

  async function deliver(row) {
    const payload = parseJson(row.payload_json, {});
    if (row.event_type === EVENT_TYPES.PACKAGE_ASSIGN) {
      const result = await client.assignPackageToRestaurant(payload.restaurantPosentegraId, payload.packagePayload || {});
      const remoteId = responseId(result);
      if (remoteId) {
        db.prepare("UPDATE packages SET posentegra_id = ?, updated_at = ? WHERE id = ?").run(remoteId, nowIso(), row.aggregate_id);
      }
      return result;
    }
    if (row.event_type === EVENT_TYPES.ORDER_STATUS) {
      const packageRow = db.prepare("SELECT posentegra_id FROM packages WHERE id = ?").get(row.aggregate_id);
      const currentOrderId = trimmed(packageRow?.posentegra_id || payload.orderId);
      if (!currentOrderId) {
        throw new Error("Posentegra order pid bulunamadi.");
      }
      const meta = {
        ...(payload.meta || {}),
        packageId: row.aggregate_id,
      };
      if (trimmed(payload.status).toLowerCase() === "delivered") {
        return advanceOrderToDelivered(currentOrderId, meta);
      }
      return client.changeOrderStatus(currentOrderId, payload.status, meta);
    }
    if (row.event_type === EVENT_TYPES.ORDER_CANCEL) {
      const packageRow = db.prepare("SELECT posentegra_id FROM packages WHERE id = ?").get(row.aggregate_id);
      const currentOrderId = trimmed(packageRow?.posentegra_id || payload.orderId);
      if (!currentOrderId) {
        throw new Error("Posentegra order pid bulunamadi.");
      }
      return client.cancelOrder(currentOrderId, payload.reason, {
        ...(payload.meta || {}),
        packageId: row.aggregate_id,
      });
    }
    throw new Error(`Desteklenmeyen Posentegra outbox olayi: ${row.event_type}`);
  }

  async function processDue(limit = 20) {
    if (!client.configured()) {
      return { processed: 0, skipped: true };
    }
    if (processing) {
      rerunRequested = true;
      return { processed: 0, skipped: true, rerunRequested: true };
    }
    processing = true;
    let processed = 0;
    let selected = 0;
    try {
      do {
        rerunRequested = false;
        const staleLock = new Date(Date.now() - 5 * 60_000).toISOString();
        // Paket atama istekleri idempotent oldugu icin eski kilitler tekrar alinabilir.
        db.prepare(`
          UPDATE posentegra_outbox
          SET status = 'pending', locked_at = NULL, updated_at = ?
          WHERE status = 'processing' AND event_type = ? AND locked_at < ?
        `).run(nowIso(), EVENT_TYPES.PACKAGE_ASSIGN, staleLock);
        // change-status uzak siparisi bir adim ilerlettigi icin, istekten sonra proses
        // kapanmis olabilecegi belirsiz durumda otomatik tekrar guvenli degildir.
        db.prepare(`
          UPDATE posentegra_outbox
          SET status = 'dead_letter', next_attempt_at = NULL, locked_at = NULL,
              last_error = COALESCE(last_error, 'Belirsiz onceki gonderim; cift durum ilerletmeyi onlemek icin manuel kontrol gerekli.'),
              updated_at = ?
          WHERE status = 'processing' AND event_type IN (?, ?) AND locked_at < ?
        `).run(nowIso(), EVENT_TYPES.ORDER_STATUS, EVENT_TYPES.ORDER_CANCEL, staleLock);
        const rows = db.prepare(`
          SELECT * FROM posentegra_outbox
          WHERE status IN ('pending', 'failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        `).all(nowIso(), Math.max(1, Math.min(100, Number(limit) || 20)));
        selected += rows.length;
        for (const row of rows) {
          if (row.event_type === EVENT_TYPES.ORDER_STATUS) {
            const currentPayload = parseJson(row.payload_json, {});
            const currentRank = statusRank(currentPayload.status);
            const earlierRows = db.prepare(`
              SELECT id, payload_json, status
              FROM posentegra_outbox
              WHERE aggregate_id = ? AND event_type = ? AND id != ? AND status != 'completed'
            `).all(row.aggregate_id, EVENT_TYPES.ORDER_STATUS, row.id);
            const blocked = earlierRows.some((candidate) => {
              const candidateRank = statusRank(parseJson(candidate.payload_json, {}).status);
              return candidateRank < currentRank;
            });
            if (blocked) {
              continue;
            }
          }
          const lockedAt = nowIso();
          const lockResult = db.prepare(`
            UPDATE posentegra_outbox SET status = 'processing', locked_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'failed')
          `).run(lockedAt, lockedAt, row.id);
          if (!lockResult.changes) {
            continue;
          }
          try {
            await deliver(row);
            db.prepare(`
              UPDATE posentegra_outbox
              SET status = 'completed', completed_at = ?, locked_at = NULL, last_error = NULL, updated_at = ?
              WHERE id = ?
            `).run(nowIso(), nowIso(), row.id);
            logger?.info?.("Posentegra outbox delivery completed", {
              outboxId: row.id,
              eventType: row.event_type,
              aggregateId: row.aggregate_id,
            });
            processed += 1;
          } catch (error) {
            const attempts = Number(row.attempts || 0) + 1;
            const nonIdempotent = row.event_type === EVENT_TYPES.ORDER_STATUS;
            const dead = nonIdempotent || attempts >= maxAttempts;
            const delayMs = Math.min(30 * 60_000, 30_000 * (2 ** Math.min(6, attempts - 1)));
            const nextAttemptAt = dead ? null : new Date(Date.now() + delayMs).toISOString();
            db.prepare(`
              UPDATE posentegra_outbox
              SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, locked_at = NULL, updated_at = ?
              WHERE id = ?
            `).run(dead ? "dead_letter" : "failed", attempts, nextAttemptAt, String(error.message || error).slice(0, 1000), nowIso(), row.id);
            logger?.warn?.("Posentegra outbox delivery failed", {
              outboxId: row.id,
              eventType: row.event_type,
              aggregateId: row.aggregate_id,
              attempts,
              deadLettered: dead,
              automaticRetryDisabled: nonIdempotent,
              nextAttemptAt,
              error: error.message,
            });
          }
        }
      } while (rerunRequested);
      return { processed, selected };
    } finally {
      processing = false;
    }
  }

  async function reconcilePackage(packageId) {
    const aggregateId = trimmed(packageId);
    if (!client.configured()) {
      const error = new Error("Posentegra baglantisi yapilandirilmamis.");
      error.statusCode = 503;
      throw error;
    }
    if (!aggregateId) {
      const error = new Error("Paket kimligi zorunludur.");
      error.statusCode = 400;
      throw error;
    }
    if (processing) {
      const error = new Error("Posentegra kuyrugu su anda isleniyor; guvenli uzlastirma icin tekrar deneyin.");
      error.statusCode = 409;
      throw error;
    }

    processing = true;
    try {
      const packageRow = db.prepare(`
        SELECT id, posentegra_id, status, failure_reason
        FROM packages WHERE id = ?
      `).get(aggregateId);
      if (!packageRow) {
        const error = new Error("Paket bulunamadi.");
        error.statusCode = 404;
        throw error;
      }
      const orderId = trimmed(packageRow.posentegra_id);
      if (!orderId) {
        const error = new Error("Paketin Posentegra pid bilgisi bulunamadi.");
        error.statusCode = 409;
        throw error;
      }
      const rows = db.prepare(`
        SELECT * FROM posentegra_outbox
        WHERE aggregate_id = ? AND event_type = ?
        ORDER BY created_at ASC
      `).all(aggregateId, EVENT_TYPES.ORDER_STATUS);
      if (!rows.length) {
        const error = new Error("Paket icin uzlastirilacak durum olayi bulunamadi.");
        error.statusCode = 404;
        throw error;
      }

      let remoteResult = await client.getOrder(orderId);
      const beforeCode = remoteStatusCode(remoteResult);
      const localStatus = trimmed(packageRow.status).toLowerCase();
      const cancelledLocally = ["cancelled", "canceled", "rejected"].includes(localStatus);

      if (cancelledLocally) {
        if (beforeCode !== 1600) {
          const cancellationNote = trimmed(packageRow.failure_reason) || "RESTOMAP operasyonu tarafından iptal edildi.";
          await client.cancelOrder(
            orderId,
            "TECHNICAL_PROBLEM",
            { note: cancellationNote, packageId: aggregateId, reconciliation: true }
          );
          remoteResult = await client.getOrder(orderId);
        }
        const verifiedCode = remoteStatusCode(remoteResult);
        if (verifiedCode !== 1600) {
          const error = new Error(`Posentegra iptali dogrulanamadi (uzak durum: ${verifiedCode ?? "bilinmiyor"}).`);
          error.statusCode = 502;
          throw error;
        }
        const stamp = nowIso();
        db.prepare(`
          UPDATE posentegra_outbox
          SET status = 'completed', completed_at = COALESCE(completed_at, ?), next_attempt_at = NULL,
              locked_at = NULL, last_error = NULL, updated_at = ?
          WHERE aggregate_id = ? AND event_type = ? AND status != 'completed'
        `).run(stamp, stamp, aggregateId, EVENT_TYPES.ORDER_STATUS);
        return {
          packageId: aggregateId,
          orderId,
          localStatus,
          remoteBefore: beforeCode,
          remoteAfter: verifiedCode,
          action: beforeCode === 1600 ? "already_cancelled" : "cancelled",
          reconciledRows: rows.filter((row) => row.status !== "completed").length,
        };
      }

      const desiredRank = desiredStatusRank(localStatus);
      let currentRank = remoteStatusRank(beforeCode);
      if (desiredRank === null || currentRank === null) {
        const error = new Error(`Durumlar guvenli uzlastirmaya uygun degil (yerel: ${localStatus || "bos"}, uzak: ${beforeCode ?? "bilinmiyor"}).`);
        error.statusCode = 409;
        throw error;
      }
      if (beforeCode === 1600) {
        const error = new Error("Posentegra siparisi iptal durumda; yerel paket ilerletilemez.");
        error.statusCode = 409;
        throw error;
      }

      const sentStatuses = [];
      if (desiredRank === 3 && beforeCode !== 900) {
        const deliveredResult = await advanceOrderToDelivered(orderId, {
          packageId: aggregateId,
          reconciliation: true,
        });
        remoteResult = deliveredResult.remoteResult;
        currentRank = remoteStatusRank(deliveredResult.remoteCode);
        sentStatuses.push(...deliveredResult.transitions.map(() => "delivered"));
      }
      while (currentRank < desiredRank) {
        const nextRank = currentRank + 1;
        const candidate = rows.find((row) => statusRank(parseJson(row.payload_json, {}).status) === nextRank);
        if (!candidate) {
          const error = new Error(`Eksik Posentegra kuyruk adimi var (hedef seviye: ${nextRank}).`);
          error.statusCode = 409;
          throw error;
        }
        const payload = parseJson(candidate.payload_json, {});
        try {
          await client.changeOrderStatus(orderId, payload.status, {
            ...(payload.meta || {}),
            packageId: aggregateId,
            reconciliation: true,
          });
          remoteResult = await client.getOrder(orderId);
        } catch (error) {
          const stamp = nowIso();
          db.prepare(`
            UPDATE posentegra_outbox
            SET status = 'dead_letter', attempts = attempts + 1, next_attempt_at = NULL,
                locked_at = NULL, last_error = ?, updated_at = ?
            WHERE id = ?
          `).run(`Uzlastirma belirsiz: ${String(error.message || error).slice(0, 900)}`, stamp, candidate.id);
          throw error;
        }
        const verifiedCode = remoteStatusCode(remoteResult);
        const verifiedRank = remoteStatusRank(verifiedCode);
        if (verifiedRank === null || verifiedRank < nextRank) {
          const error = new Error(`Posentegra durum ilerlemesi dogrulanamadi (uzak durum: ${verifiedCode ?? "bilinmiyor"}).`);
          error.statusCode = 502;
          const stamp = nowIso();
          db.prepare(`
            UPDATE posentegra_outbox
            SET status = 'dead_letter', next_attempt_at = NULL, locked_at = NULL,
                last_error = ?, updated_at = ? WHERE id = ?
          `).run(error.message, stamp, candidate.id);
          throw error;
        }
        sentStatuses.push(payload.status);
        currentRank = verifiedRank;
      }

      const afterCode = remoteStatusCode(remoteResult);
      const stamp = nowIso();
      for (const row of rows) {
        const rank = statusRank(parseJson(row.payload_json, {}).status);
        if (rank <= currentRank && row.status !== "completed") {
          db.prepare(`
            UPDATE posentegra_outbox
            SET status = 'completed', completed_at = COALESCE(completed_at, ?), next_attempt_at = NULL,
                locked_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?
          `).run(stamp, stamp, row.id);
        }
      }
      return {
        packageId: aggregateId,
        orderId,
        localStatus,
        remoteBefore: beforeCode,
        remoteAfter: afterCode,
        action: sentStatuses.length ? "advanced_and_verified" : "already_reconciled",
        sentStatuses,
        reconciledRows: rows.filter((row) => statusRank(parseJson(row.payload_json, {}).status) <= currentRank && row.status !== "completed").length,
      };
    } finally {
      processing = false;
      if (rerunRequested) {
        rerunRequested = false;
        setImmediate(() => processDue().catch((error) => logger?.warn?.("Posentegra outbox post-reconcile sweep failed", { error: error.message })));
      }
    }
  }

  function health() {
    const counts = db.prepare(`
      SELECT status, COUNT(*) AS count FROM posentegra_outbox GROUP BY status
    `).all();
    return {
      processing,
      counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count || 0)])),
    };
  }

  return {
    EVENT_TYPES,
    enqueuePackageAssignment,
    enqueueStatus,
    enqueueCancellation,
    processDue,
    reconcilePackage,
    health,
  };
}

module.exports = { createPosentegraOutboxService, EVENT_TYPES };
