const crypto = require("crypto");

function trimmed(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function hmacHex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function normalizePlatform(value) {
  return trimmed(value).toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
}

function callbackEnvKeys(platform) {
  const suffix = trimmed(platform).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return [`RESTOMAP_PLATFORM_CALLBACK_URL_${suffix}`, `DELIVERA_PLATFORM_CALLBACK_URL_${suffix}`];
}

function resolveCallbackUrl(account, packageRecord) {
  return trimmed(
    account?.callback_url ||
    callbackEnvKeys(packageRecord?.sourcePlatform).map((key) => process.env[key]).find(Boolean) ||
    process.env.RESTOMAP_PLATFORM_CALLBACK_URL ||
    process.env.DELIVERA_PLATFORM_CALLBACK_URL ||
    process.env.PLATFORM_CALLBACK_URL
  );
}

function findCallbackAccount(db, packageRecord) {
  if (!db || !packageRecord?.restaurantId || !packageRecord?.sourcePlatform) {
    return null;
  }

  const rows = db.prepare(`
    SELECT * FROM platform_accounts
    WHERE restaurant_id = ? AND active = 1
  `).all(packageRecord.restaurantId);
  const target = normalizePlatform(packageRecord.sourcePlatform);
  return rows.find((row) => normalizePlatform(row.platform) === target) || null;
}

function callbackOutcomeAlreadyRecorded(packageRecord, status, meta = {}, result = {}) {
  const logs = Array.isArray(packageRecord?.platformStatusLogs) ? packageRecord.platformStatusLogs : [];
  const callbackMode = trimmed(result.mode || result.status);
  if (callbackMode !== "not_configured") {
    return false;
  }
  const courierId = trimmed(meta.courierId || packageRecord?.assignedCourierId);
  return logs.some((entry) => {
    if (trimmed(entry?.status) !== trimmed(status)) return false;
    if (trimmed(entry?.meta?.callbackMode || entry?.meta?.callbackStatus) !== callbackMode) return false;
    if (trimmed(status) === "assigned") {
      return trimmed(entry?.meta?.courierId) === courierId;
    }
    return true;
  });
}

async function sendPlatformStatusCallback({ db, packageRecord, status, meta = {}, timeoutMs = 8000 }) {
  const account = findCallbackAccount(db, packageRecord);
  const callbackUrl = resolveCallbackUrl(account, packageRecord);
  if (!callbackUrl) {
    return {
      ok: false,
      platformAccountId: account?.id || null,
      status: "not_configured",
      mode: "not_configured",
      error: "Platform callback URL not configured",
    };
  }

  const payload = JSON.stringify({
    event: "restomap.status.updated",
    legacyEvent: "delivera.status.updated",
    platform: packageRecord.sourcePlatform,
    orderId: packageRecord.externalOrderId || packageRecord.externalOrderNo,
    packageId: packageRecord.id,
    restaurantId: packageRecord.restaurantId,
    platformRestaurantId: packageRecord.platformRestaurantId || packageRecord.externalRestaurantId || null,
    posentegraId: packageRecord.posentegraId || null,
    courierId: packageRecord.assignedCourierId || null,
    status,
    meta,
    sentAt: nowIso(),
  });
  const secret = trimmed(account.webhook_secret || account.api_secret || account.static_token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Restomap-Event": "status.updated",
        "X-Delivera-Event": "status.updated",
        ...(secret ? {
          "X-Restomap-Signature": hmacHex(secret, payload),
          "X-Delivera-Signature": hmacHex(secret, payload),
        } : {}),
      },
      body: payload,
    });
    const text = await response.text().catch(() => "");
    return {
      ok: response.ok,
      platformAccountId: account?.id || null,
      status: response.status,
      mode: "http_callback",
      responseBody: text.slice(0, 500),
      error: response.ok ? "" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      platformAccountId: account?.id || null,
      status: error.name === "AbortError" ? "timeout" : "network_error",
      mode: "http_callback",
      error: error.name === "AbortError" ? "callback_timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  sendPlatformStatusCallback,
  callbackOutcomeAlreadyRecorded,
};
