const HEALTH_STATUS = Object.freeze({
  UNKNOWN: "unknown",
  CONNECTED: "connected",
  WARNING: "warning",
  ERROR: "error",
  DISABLED: "disabled",
});

const HEALTH_ERROR_CODES = Object.freeze({
  NETWORK_ERROR: "network_error",
  TIMEOUT: "timeout",
  DNS_ERROR: "dns_error",
  UNAUTHORIZED: "unauthorized",
  INVALID_SIGNATURE: "invalid_signature",
  PROVIDER_NOT_CONFIGURED: "provider_not_configured",
  CALLBACK_FAILED: "callback_failed",
  WEBHOOK_NOT_RECEIVED: "webhook_not_received",
  RATE_LIMITED: "rate_limited",
  UNKNOWN_ERROR: "unknown_error",
});

function trimmed(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeErrorCode(error, httpStatus) {
  const message = trimmed(error?.message || error).toLowerCase();
  if (error?.name === "AbortError" || message.includes("timeout")) {
    return HEALTH_ERROR_CODES.TIMEOUT;
  }
  if (message.includes("enotfound") || message.includes("dns")) {
    return HEALTH_ERROR_CODES.DNS_ERROR;
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return HEALTH_ERROR_CODES.UNAUTHORIZED;
  }
  if (httpStatus === 429) {
    return HEALTH_ERROR_CODES.RATE_LIMITED;
  }
  if (message.includes("not configured") || message.includes("not_configured")) {
    return HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED;
  }
  if (message.includes("signature")) {
    return HEALTH_ERROR_CODES.INVALID_SIGNATURE;
  }
  if (message.includes("network") || message.includes("fetch failed") || message.includes("econn")) {
    return HEALTH_ERROR_CODES.NETWORK_ERROR;
  }
  return HEALTH_ERROR_CODES.UNKNOWN_ERROR;
}

function publicMessageFor(code) {
  return {
    [HEALTH_ERROR_CODES.NETWORK_ERROR]: "Ag baglantisi veya saglayici erisimi basarisiz.",
    [HEALTH_ERROR_CODES.TIMEOUT]: "Platform yaniti zaman asimina ugradi.",
    [HEALTH_ERROR_CODES.DNS_ERROR]: "Platform adresine ulasilamadi.",
    [HEALTH_ERROR_CODES.UNAUTHORIZED]: "Platform yetkilendirmesi reddedildi.",
    [HEALTH_ERROR_CODES.INVALID_SIGNATURE]: "Webhook secret veya imza ayari hatali gorunuyor.",
    [HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED]: "Platform saglayicisi yapilandirilmamis.",
    [HEALTH_ERROR_CODES.CALLBACK_FAILED]: "Platform callback bildirimi basarisiz oldu.",
    [HEALTH_ERROR_CODES.WEBHOOK_NOT_RECEIVED]: "Son webhook uzun suredir gelmedi.",
    [HEALTH_ERROR_CODES.RATE_LIMITED]: "Platform rate-limit cevabi verdi.",
    [HEALTH_ERROR_CODES.UNKNOWN_ERROR]: "Platform baglantisi kontrol edilemedi.",
  }[code] || "Platform baglantisi kontrol edilemedi.";
}

function statusLabel(status) {
  return {
    [HEALTH_STATUS.CONNECTED]: "Bagli",
    [HEALTH_STATUS.WARNING]: "Uyari",
    [HEALTH_STATUS.ERROR]: "Hatali",
    [HEALTH_STATUS.DISABLED]: "Devre disi",
    [HEALTH_STATUS.UNKNOWN]: "Kontrol edilmedi",
  }[status] || "Kontrol edilmedi";
}

function buildHealthPayload(account) {
  const status = account?.connectionStatus || account?.connection_status || account?.status || HEALTH_STATUS.UNKNOWN;
  const code = account?.lastErrorCode || account?.last_error_code || account?.errorCode || "";
  const message = account?.lastErrorMessage || account?.last_error_message || account?.errorMessage || account?.lastError || account?.last_error || "";
  return {
    status,
    label: statusLabel(status),
    publicMessage: status === HEALTH_STATUS.CONNECTED
      ? "Baglanti aktif. Son kontrol basarili."
      : status === HEALTH_STATUS.WARNING
        ? publicMessageFor(code || HEALTH_ERROR_CODES.WEBHOOK_NOT_RECEIVED)
        : status === HEALTH_STATUS.DISABLED
          ? "Platform saglayicisi yapilandirilmamis."
          : status === HEALTH_STATUS.ERROR
            ? publicMessageFor(code || HEALTH_ERROR_CODES.UNKNOWN_ERROR)
            : "Baglanti henuz dogrulanmadi. Son durumu kontrol edin.",
    lastErrorCode: code,
    lastErrorMessage: message,
    lastHttpStatus: account?.lastHttpStatus ?? account?.last_http_status ?? account?.httpStatus ?? null,
    lastLatencyMs: account?.lastLatencyMs ?? account?.last_latency_ms ?? account?.latencyMs ?? null,
    consecutiveFailures: account?.consecutiveFailures ?? account?.consecutive_failures ?? 0,
    lastCheckAt: account?.lastCheckAt || account?.last_check_at || account?.checkedAt || null,
    lastSuccessAt: account?.lastSuccessAt || account?.last_success_at || null,
    lastErrorAt: account?.lastErrorAt || account?.last_error_at || null,
    lastWebhookAt: account?.lastWebhookAt || account?.last_webhook_at || null,
    lastCallbackAt: account?.lastCallbackAt || account?.last_callback_at || null,
  };
}

function createConnectionHealthService(deps = {}) {
  const {
    db,
    fetchImpl = fetch,
    logger = console,
    platformAccountMissingCredentials = () => false,
    providerHealthUrlForAccount = () => "",
    timeoutMs = 8000,
  } = deps;

  function updateAccountHealth(accountId, result) {
    const now = result.checkedAt || nowIso();
    const status = result.status || HEALTH_STATUS.UNKNOWN;
    const failureIncrement = status === HEALTH_STATUS.CONNECTED || status === HEALTH_STATUS.UNKNOWN ? 0 : 1;
    const resetFailures = status === HEALTH_STATUS.CONNECTED || status === HEALTH_STATUS.DISABLED;
    db.prepare(`
      UPDATE platform_accounts
      SET connection_status = ?,
          last_check_at = ?,
          last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
          last_error_at = CASE WHEN ? THEN ? ELSE last_error_at END,
          last_error_code = ?,
          last_error_message = ?,
          last_http_status = ?,
          last_latency_ms = ?,
          consecutive_failures = CASE WHEN ? THEN 0 ELSE COALESCE(consecutive_failures, 0) + ? END,
          last_error = CASE WHEN ? THEN NULL ELSE ? END,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      now,
      status === HEALTH_STATUS.CONNECTED ? 1 : 0,
      now,
      status === HEALTH_STATUS.ERROR || status === HEALTH_STATUS.WARNING || status === HEALTH_STATUS.DISABLED ? 1 : 0,
      now,
      result.errorCode || null,
      result.errorMessage || null,
      result.httpStatus || null,
      result.latencyMs || null,
      resetFailures ? 1 : 0,
      failureIncrement,
      status === HEALTH_STATUS.CONNECTED || status === HEALTH_STATUS.UNKNOWN ? 1 : 0,
      result.errorMessage || null,
      now,
      accountId
    );
  }

  async function checkAccount(account, options = {}) {
    const startedAt = Date.now();
    const checkedAt = nowIso();
    if (!account?.active || account?.webhookEnabled === false && account?.pollingEnabled === false) {
      const result = {
        ok: false,
        status: HEALTH_STATUS.DISABLED,
        checkedAt,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Platform hesabi devre disi.",
        latencyMs: Date.now() - startedAt,
      };
      updateAccountHealth(account.id, result);
      return { ...result, health: buildHealthPayload({ ...account, ...result }) };
    }

    const webhookReady = Boolean(account.webhookEnabled !== false && (account.webhookSecret || account.staticToken || account.webhookApiKey) && account.externalStoreId);
    if (platformAccountMissingCredentials(account) && !webhookReady) {
      const result = {
        ok: false,
        status: HEALTH_STATUS.DISABLED,
        checkedAt,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Platform credential veya webhook secret eksik.",
        latencyMs: Date.now() - startedAt,
      };
      updateAccountHealth(account.id, result);
      return { ...result, health: buildHealthPayload({ ...account, ...result }) };
    }

    const providerUrl = trimmed(providerHealthUrlForAccount(account));
    if (!providerUrl) {
      const staleWebhook = !account.lastWebhookAt;
      const hasSuccess = Boolean(account.lastWebhookAt || account.lastPollAt || account.lastSuccessAt);
      const result = hasSuccess
        ? {
            ok: true,
            status: HEALTH_STATUS.CONNECTED,
            checkedAt,
            errorCode: null,
            errorMessage: null,
            latencyMs: Date.now() - startedAt,
          }
        : {
            ok: false,
            status: staleWebhook ? HEALTH_STATUS.WARNING : HEALTH_STATUS.UNKNOWN,
            checkedAt,
            errorCode: HEALTH_ERROR_CODES.WEBHOOK_NOT_RECEIVED,
            errorMessage: "Provider verify endpoint tanimli degil; ilk basarili webhook bekleniyor.",
            latencyMs: Date.now() - startedAt,
          };
      updateAccountHealth(account.id, result);
      return { ...result, providerUrlConfigured: false, health: buildHealthPayload({ ...account, ...result }) };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(providerUrl, {
        method: options.method || "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "RESTOMAP-HealthCheck",
          "X-Restomap-Platform": account.platform || "",
          "X-Delivera-Platform": account.platform || "",
          ...(account.apiKey ? { "X-API-Key": account.apiKey } : {}),
          ...(account.apiSecret ? { "X-API-Secret": account.apiSecret } : {}),
          ...(account.token || account.accessToken ? { Authorization: `Bearer ${account.token || account.accessToken}` } : {}),
        },
      });
      const latencyMs = Date.now() - startedAt;
      const code = normalizeErrorCode(null, response.status);
      const result = response.ok
        ? { ok: true, status: HEALTH_STATUS.CONNECTED, checkedAt, httpStatus: response.status, latencyMs }
        : {
            ok: false,
            status: response.status === 401 || response.status === 403 || response.status >= 500 ? HEALTH_STATUS.ERROR : HEALTH_STATUS.WARNING,
            checkedAt,
            httpStatus: response.status,
            latencyMs,
            errorCode: code,
            errorMessage: `Provider health endpoint HTTP ${response.status} dondu.`,
          };
      updateAccountHealth(account.id, result);
      return { ...result, providerUrlConfigured: true, health: buildHealthPayload({ ...account, ...result }) };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const errorCode = normalizeErrorCode(error);
      const result = {
        ok: false,
        status: errorCode === HEALTH_ERROR_CODES.TIMEOUT || errorCode === HEALTH_ERROR_CODES.DNS_ERROR ? HEALTH_STATUS.ERROR : HEALTH_STATUS.WARNING,
        checkedAt,
        latencyMs,
        errorCode,
        errorMessage: errorCode === HEALTH_ERROR_CODES.TIMEOUT ? "Provider health check timeout." : error.message,
      };
      updateAccountHealth(account.id, result);
      logger.warn?.("Platform connection health check failed", {
        platformAccountId: account.id,
        platform: account.platform,
        errorCode,
        error: error.message,
      });
      return { ...result, providerUrlConfigured: true, health: buildHealthPayload({ ...account, ...result }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    checkAccount,
    buildHealthPayload,
    updateAccountHealth,
  };
}

module.exports = {
  createConnectionHealthService,
  HEALTH_STATUS,
  HEALTH_ERROR_CODES,
  buildHealthPayload,
  normalizeErrorCode,
  publicMessageFor,
};
