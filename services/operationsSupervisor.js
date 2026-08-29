const logger = require("./logger");
const crypto = require("node:crypto");

const TERMINAL_STATUSES = new Set(["delivered", "cancelled", "rejected"]);
const WAITING_STATUSES = new Set(["pending", "preparing", "awaiting_assignment", "failed"]);
const ACTIVE_STATUSES = new Set(["assigned", "accepted_by_courier", "on_route"]);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timestamp(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function minutesSince(value, nowMs) {
  const then = timestamp(value);
  return then ? Math.max(0, Math.floor((nowMs - then) / 60_000)) : 0;
}

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function previousIstanbulDate(date) {
  return istanbulParts(new Date(date.getTime() - 8 * 60 * 60 * 1000)).date;
}

function packageLabel(pkg) {
  return pkg.trackingNo || pkg.externalOrderNo || pkg.id || "bilinmeyen paket";
}

function restaurantLabel(pkg) {
  return pkg.restaurantName || pkg.restaurantId || "bilinmeyen işletme";
}

function summarizeItems(items, formatter, maxItems = 5) {
  const sample = items.slice(0, maxItems).map(formatter);
  if (items.length > maxItems) sample.push(`… ve ${items.length - maxItems} kayıt daha`);
  return sample.join("\n");
}

function severity(level, message) {
  const labels = { info: "BİLGİ", warning: "UYARI", critical: "KRİTİK", emergency: "ACİL" };
  return `[${labels[level] || labels.info}] ${message}`;
}

function dailyReport(summary, reportDate, title = "Sabah operasyon raporu") {
  return [
    severity("info", `${title} (${reportDate})`),
    `• Gelen paket: ${summary.total || 0}`,
    `• Teslim edilen: ${summary.delivered || 0}`,
    `• İptal/reddedilen: ${summary.cancelled || 0}`,
    `• Şu an aktif paket: ${summary.active || 0}`,
    `• Atama bekleyen: ${summary.waiting || 0}`,
    `• Canlı kurye: ${summary.onlineCouriers || 0}`,
  ].join("\n");
}

function statusLabel(status) {
  return {
    pending: "bekliyor",
    preparing: "hazırlanıyor",
    awaiting_assignment: "atama bekliyor",
    failed: "atama hatası",
    assigned: "atandı",
    accepted_by_courier: "kurye kabul etti",
    on_route: "yolda",
    delivered: "teslim edildi",
    cancelled: "iptal",
    rejected: "reddedildi",
  }[status] || status || "bilinmiyor";
}

function normalizedSearch(value) {
  return String(value || "").trim().toLocaleLowerCase("tr-TR");
}

function percentage(value) {
  const number = Number(value || 0);
  return `%${Number.isFinite(number) ? number.toFixed(1) : "0.0"}`;
}

function signedPercentage(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "%0.0";
  return `${number > 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isOnlineCourier(courier) {
  return ["online", "busy"].includes(courier?.status);
}

function commandArg(args) {
  return args.join(" ").trim();
}

function approvalCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function analyticsReport(analytics, periodLabel) {
  const totals = analytics?.totals || {};
  const topRestaurant = safeArray(analytics?.restaurants)[0];
  const topCourier = safeArray(analytics?.couriers)[0];
  return [
    severity("info", `${periodLabel} operasyon analizi`),
    `• Paket: ${totals.total || 0}`,
    `• Teslim: ${totals.delivered || 0} (${percentage(totals.deliveryRate)})`,
    `• İptal/ret: ${totals.cancelled || 0}`,
    `• Ortalama atama: ${Number(totals.avgAssignmentMinutes || 0).toFixed(1)} dk`,
    `• Ortalama teslim: ${Number(totals.avgDeliveryMinutes || 0).toFixed(1)} dk`,
    topRestaurant ? `• En yoğun işletme: ${topRestaurant.name} (${topRestaurant.total} paket)` : "• İşletme verisi yok",
    topCourier ? `• En çok teslim: ${topCourier.name} (${topCourier.delivered} teslim)` : "• Kurye teslim verisi yok",
  ].join("\n");
}

function forecastReport(analytics, snapshot) {
  const forecast = analytics?.forecast || {};
  const couriers = safeArray(snapshot?.couriers).filter(isOnlineCourier);
  const active = safeArray(snapshot?.packages).filter((pkg) => ACTIVE_STATUSES.has(pkg.status)).length;
  const waiting = safeArray(snapshot?.packages).filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId).length;
  const capacity = Math.max(0, couriers.length * 2 - active);
  const pressure = waiting > capacity ? "YÜKSEK" : active >= Math.max(1, couriers.length * 1.5) ? "ORTA" : "NORMAL";
  return [
    severity(pressure === "YÜKSEK" ? "warning" : "info", "Kapasite ve yoğunluk tahmini"),
    `• Bugün beklenen paket: ${Math.round(Number(forecast.expectedToday || 0))}`,
    `• Şu ana kadar: ${Number(forecast.todaySoFar || 0)}`,
    `• Geçen dönem farkı: ${signedPercentage(forecast.changePercent)}`,
    `• Canlı kurye: ${couriers.length}`,
    `• Aktif/bekleyen: ${active}/${waiting}`,
    `• Yaklaşık boş kapasite: ${capacity} paket`,
    `• Operasyon baskısı: ${pressure}`,
  ].join("\n");
}

function createOperationsSupervisor(options = {}) {
  const getSnapshot = options.getSnapshot;
  const getDailySummary = options.getDailySummary || null;
  const getHealthSnapshot = options.getHealthSnapshot || null;
  const getAnalyticsSnapshot = options.getAnalyticsSnapshot || null;
  const findPackage = options.findPackage || null;
  const retryPackage = options.retryPackage || null;
  const recordAction = options.recordAction || (async () => {});
  const rebalance = options.rebalance || (() => {});
  const telegram = options.telegram;
  const log = options.logger || logger;
  const now = options.now || (() => new Date());
  const intervalMs = positiveNumber(options.intervalMs ?? process.env.DELIVERA_SUPERVISOR_INTERVAL_MS, 60_000);
  const commandPollMs = positiveNumber(options.commandPollMs ?? process.env.TELEGRAM_COMMAND_POLL_MS, 5_000);
  const healthCheckIntervalMs = positiveNumber(options.healthCheckIntervalMs ?? process.env.DELIVERA_HEALTH_CHECK_INTERVAL_MS, 300_000);
  const waitingAlertMinutes = positiveNumber(options.waitingAlertMinutes ?? process.env.DELIVERA_WAITING_ALERT_MINUTES, 5);
  const acceptedAlertMinutes = positiveNumber(options.acceptedAlertMinutes ?? process.env.DELIVERA_ACCEPTED_ALERT_MINUTES, 20);
  const routeAlertMinutes = positiveNumber(options.routeAlertMinutes ?? process.env.DELIVERA_ROUTE_ALERT_MINUTES, 60);
  const staleLocationMinutes = positiveNumber(options.staleLocationMinutes ?? process.env.DELIVERA_STALE_LOCATION_ALERT_MINUTES, 30);
  const repeatMinutes = positiveNumber(options.repeatMinutes ?? process.env.DELIVERA_ALERT_REPEAT_MINUTES, 60);
  const escalationMinutes = positiveNumber(options.escalationMinutes ?? process.env.DELIVERA_ALERT_ESCALATION_MINUTES, 20);
  const remediationCooldownMinutes = positiveNumber(options.remediationCooldownMinutes ?? process.env.DELIVERA_REMEDIATION_COOLDOWN_MINUTES, 5);
  const approvalTtlMinutes = positiveNumber(options.approvalTtlMinutes ?? process.env.DELIVERA_APPROVAL_TTL_MINUTES, 5);
  const maxAlertsPerInspection = Math.max(1, Math.min(20, positiveNumber(options.maxAlertsPerInspection ?? process.env.DELIVERA_MAX_ALERTS_PER_INSPECTION, 6)));
  const createApprovalCode = options.createApprovalCode || approvalCode;
  const dailyReportHour = Math.max(0, Math.min(23, Number(options.dailyReportHour ?? process.env.DELIVERA_DAILY_REPORT_HOUR ?? 9)));
  const dayCloseHour = Math.max(0, Math.min(23, Number(options.dayCloseHour ?? process.env.DELIVERA_DAY_CLOSE_REPORT_HOUR ?? 0)));
  const dayCloseMinute = Math.max(0, Math.min(59, Number(options.dayCloseMinute ?? process.env.DELIVERA_DAY_CLOSE_REPORT_MINUTE ?? 5)));
  const alertState = new Map();
  const incidentState = new Map();
  const remediationState = new Map();
  const pendingApprovals = new Map();
  const completedApprovals = new Map();
  let timer = null;
  let commandTimer = null;
  let running = false;
  let commandRunning = false;
  let commandOffset = null;
  let lastDailyReportDate = "";
  let lastDayCloseReportDate = "";
  let lastHealthCheckAt = 0;
  let alertsSentThisInspection = 0;

  function shouldSend(key, nowMs) {
    return nowMs - (alertState.get(key) || 0) >= repeatMinutes * 60_000;
  }

  async function alert(key, message, nowMs) {
    if (!shouldSend(key, nowMs)) return false;
    if (alertsSentThisInspection >= maxAlertsPerInspection) return false;
    const result = await telegram.sendMessage(message);
    if (result.ok) {
      alertState.set(key, nowMs);
      alertsSentThisInspection += 1;
    }
    return Boolean(result.ok);
  }

  async function audit(action, details = {}) {
    try {
      await recordAction({ action, details, createdAt: now().toISOString() });
    } catch (error) {
      log.warn("Operations supervisor audit failed", { action, error });
    }
  }

  async function registerIncident(key, level, title, message, current) {
    const nowMs = current.getTime();
    const existing = incidentState.get(key);
    const incident = existing || {
      key,
      level,
      title,
      firstSeenAt: nowMs,
      lastSeenAt: nowMs,
      occurrences: 0,
      escalated: false,
      alerted: false,
    };
    incident.level = level;
    incident.title = title;
    incident.lastSeenAt = nowMs;
    incident.occurrences += 1;
    incidentState.set(key, incident);

    const sent = await alert(key, message, nowMs);
    if (sent) incident.alerted = true;

    if (!incident.escalated && incident.alerted && nowMs - incident.firstSeenAt >= escalationMinutes * 60_000) {
      const escalationKey = `escalation:${key}`;
      const escalated = await alert(escalationKey, [
        severity(level === "warning" ? "critical" : "emergency", `${title} hâlâ çözülmedi.`),
        `İlk tespit: ${Math.max(1, minutesSince(new Date(incident.firstSeenAt).toISOString(), nowMs))} dk önce`,
        `Tekrar sayısı: ${incident.occurrences}`,
      ].join("\n"), nowMs);
      if (escalated) incident.escalated = true;
    }
    return incident;
  }

  async function resolveInactiveIncidents(activeKeys, current) {
    for (const [key, incident] of incidentState.entries()) {
      if (activeKeys.has(key)) continue;
      incidentState.delete(key);
      alertState.delete(key);
      alertState.delete(`escalation:${key}`);
      if (incident.alerted && alertsSentThisInspection < maxAlertsPerInspection) {
        const result = await telegram.sendMessage(severity("info", `ÇÖZÜLDÜ: ${incident.title}`));
        if (result.ok) alertsSentThisInspection += 1;
      }
      await audit("incident_resolved", {
        key,
        title: incident.title,
        durationMinutes: minutesSince(new Date(incident.firstSeenAt).toISOString(), current.getTime()),
      });
    }
  }

  function pruneApprovals(nowMs) {
    for (const [code, approval] of pendingApprovals.entries()) {
      if (approval.expiresAt <= nowMs) pendingApprovals.delete(code);
    }
    for (const [code, completedAt] of completedApprovals.entries()) {
      if (nowMs - completedAt > 24 * 60 * 60 * 1000) completedApprovals.delete(code);
    }
  }

  function cleanResolvedAlerts(activeKeys) {
    for (const key of alertState.keys()) {
      if (!activeKeys.has(key) && !key.startsWith("daily:") && !key.startsWith("health:")) alertState.delete(key);
    }
  }

  function healthIssues(health) {
    const issues = [];
    if (!health?.database?.ok) issues.push(["critical", "Veritabanı sağlık kontrolü başarısız."]);
    if (health?.database?.postgresRequired && !health?.database?.postgresUrlConfigured) {
      issues.push(["emergency", "Canlı ortamda PostgreSQL bağlantısı yapılandırılmamış."]);
    }
    if (health?.integrations?.incomingWebhook?.enabled && !health?.integrations?.incomingWebhook?.secretConfigured) {
      issues.push(["critical", "Sipariş webhook'u açık fakat güvenlik anahtarı eksik."]);
    }
    const outbox = health?.integrations?.posentegra?.outbox?.counts || {};
    if (health?.integrations?.posentegra?.outboundConfigured === false) {
      issues.push(["critical", "Posentegra geri durum gönderme bağlantısı yapılandırılmamış."]);
    }
    if (health?.integrations?.posentegra?.outboundConfigured && health?.integrations?.posentegra?.businessIdConfigured === false) {
      issues.push(["warning", "Posentegra bağlantısı açık fakat işletme kimliği yapılandırılmamış."]);
    }
    if (Number(outbox.failed || 0) > 0) issues.push(["critical", `Posentegra geri bildirim kuyruğunda ${outbox.failed} başarısız kayıt var.`]);
    if (Number(outbox.dead_letter || 0) > 0) issues.push(["emergency", `Posentegra kuyruğunda manuel kontrol isteyen ${outbox.dead_letter} kilitli kayıt var.`]);
    if (Number(health?.platformHealth?.error || 0) > 0) issues.push(["warning", `${health.platformHealth.error} platform hesabı hata durumunda.`]);
    if (Number(health?.platformHealth?.webhookErrorsLast24h || 0) > 0) {
      issues.push(["warning", `Son 24 saatte ${health.platformHealth.webhookErrorsLast24h} webhook hatası oluştu.`]);
    }
    const queue = health?.queues?.queueService;
    if (queue?.initError) issues.push(["warning", `Kuyruk servisi Redis yerine güvenli yerel modda: ${queue.initError}`]);
    return issues;
  }

  async function inspectHealth(current, activeKeys) {
    if (!getHealthSnapshot) return;
    if (current.getTime() - lastHealthCheckAt < healthCheckIntervalMs) {
      // Sağlık kontrolü bu turda zamanlanmadıysa önceki sağlık olaylarını
      // yanlışlıkla "çözüldü" sayma. Bir sonraki gerçek kontrolde kapanırlar.
      for (const key of incidentState.keys()) {
        if (key.startsWith("health:")) activeKeys.add(key);
      }
      return;
    }
    lastHealthCheckAt = current.getTime();
    try {
      const health = await getHealthSnapshot();
      const issues = healthIssues(health);
      for (const [level, text] of issues) {
        const key = `health:${level}:${text}`;
        activeKeys.add(key);
        await registerIncident(key, level, text, severity(level, text), current);
      }
    } catch (error) {
      const key = "health:emergency:check-failed";
      activeKeys.add(key);
      const title = "Sistem sağlık kontrolü çalıştırılamadı";
      await registerIncident(key, "emergency", title, severity("emergency", `${title}: ${error.message}`), current);
    }
  }

  async function sendScheduledReports(current, packages, couriers, waitingPackages) {
    if (!getDailySummary) return;
    const local = istanbulParts(current);
    if (local.hour >= dailyReportHour && lastDailyReportDate !== local.date) {
      const summary = await getDailySummary(local.date);
      const result = await telegram.sendMessage(dailyReport(summary, local.date));
      if (result.ok) lastDailyReportDate = local.date;
    }
    // Kapanış yalnız gece/sabah penceresinde gönderilir. Uygulama öğleden sonra
    // yeniden başlarsa geçmiş raporu tekrar Telegram'a yağdırmaz.
    const closeReached = local.hour < dailyReportHour
      && (local.hour > dayCloseHour || (local.hour === dayCloseHour && local.minute >= dayCloseMinute));
    if (closeReached && lastDayCloseReportDate !== local.date) {
      const reportDate = previousIstanbulDate(current);
      const summary = await getDailySummary(reportDate);
      const result = await telegram.sendMessage(dailyReport(summary, reportDate, "Gün sonu kapanış raporu"));
      if (result.ok) lastDayCloseReportDate = local.date;
    }
  }

  async function inspect() {
    if (running) return { skipped: true, reason: "already_running" };
    running = true;
    try {
      const current = now();
      const nowMs = current.getTime();
      alertsSentThisInspection = 0;
      pruneApprovals(nowMs);
      const snapshot = await getSnapshot();
      const packages = snapshot?.packages || [];
      const couriers = snapshot?.couriers || [];
      const courierById = new Map(couriers.map((courier) => [courier.id, courier]));
      const activeKeys = new Set();
      const waitingPackages = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId);
      const overdueWaiting = waitingPackages.filter((pkg) => minutesSince(pkg.createdAt || pkg.updatedAt, nowMs) >= waitingAlertMinutes);

      if (overdueWaiting.length) {
        const key = "waiting-packages";
        activeKeys.add(key);
        // Müdahale ikinci bir atama motoru oluşturmaz. Var olan kilitli ve
        // idempotent motoru, kontrollü bekleme süresinde yalnız bir kez uyandırır.
        const lastRemediation = remediationState.get(key) || 0;
        if (nowMs - lastRemediation >= remediationCooldownMinutes * 60_000) {
          remediationState.set(key, nowMs);
          try {
            await rebalance();
            await audit("automatic_safe_rebalance", {
              packageIds: overdueWaiting.map((pkg) => pkg.id),
              count: overdueWaiting.length,
            });
          } catch (error) {
            await audit("automatic_safe_rebalance_failed", { error: error.message });
            log.warn("Operations supervisor rebalance failed", { error });
          }
        }
        await registerIncident(key, "critical", "Paketler atama bekliyor", [
          severity("critical", `${overdueWaiting.length} paket atama bekliyor.`),
          summarizeItems(overdueWaiting, (pkg) => `• ${packageLabel(pkg)} · ${restaurantLabel(pkg)} · ${minutesSince(pkg.createdAt || pkg.updatedAt, nowMs)} dk · ${pkg.lastAssignmentError || pkg.assignmentReason || "uygun canlı kurye yok"}`),
        ].join("\n"), current);
      }

      const inactiveCourierPackages = [];
      const acceptedStuck = [];
      const routeStuck = [];
      for (const pkg of packages) {
        if (!ACTIVE_STATUSES.has(pkg.status) || !pkg.assignedCourierId) continue;
        const courier = courierById.get(pkg.assignedCourierId);
        if (!courier || !["online", "busy"].includes(courier.status)) inactiveCourierPackages.push(pkg);
        if (pkg.status === "accepted_by_courier" && minutesSince(pkg.acceptedAt || pkg.updatedAt, nowMs) >= acceptedAlertMinutes) acceptedStuck.push(pkg);
        if (pkg.status === "on_route" && minutesSince(pkg.onRouteAt || pkg.updatedAt, nowMs) >= routeAlertMinutes) routeStuck.push(pkg);
      }

      const grouped = [
        ["inactive-couriers", inactiveCourierPackages, "critical", "Aktif paket çevrimdışı kuryede", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${pkg.status}`],
        ["accepted-stuck", acceptedStuck, "warning", "Kurye kabul etti fakat yola çıkmadı", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${minutesSince(pkg.acceptedAt || pkg.updatedAt, nowMs)} dk`],
        ["route-stuck", routeStuck, "critical", "Uzun süredir yolda olan paket", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${minutesSince(pkg.onRouteAt || pkg.updatedAt, nowMs)} dk`],
      ];
      for (const [key, items, level, title, formatter] of grouped) {
        if (!items.length) continue;
        activeKeys.add(key);
        await registerIncident(key, level, title, `${severity(level, `${title} (${items.length})`)}\n${summarizeItems(items, formatter)}`, current);
      }

      const staleCouriers = couriers.filter((courier) => ["online", "busy"].includes(courier.status) && minutesSince(courier.lastLocationAt, nowMs) >= staleLocationMinutes);
      if (staleCouriers.length) {
        const key = "stale-locations";
        activeKeys.add(key);
        await registerIncident(key, "warning", "Kurye konumları güncel değil", [
          severity("warning", `${staleCouriers.length} kuryenin konumu güncel değil.`),
          summarizeItems(staleCouriers, (courier) => `• ${courier.name || courier.id} · ${minutesSince(courier.lastLocationAt, nowMs)} dk · ${courier.status}`),
        ].join("\n"), current);
      }

      await inspectHealth(current, activeKeys);
      await sendScheduledReports(current, packages, couriers, waitingPackages);
      await resolveInactiveIncidents(activeKeys, current);
      cleanResolvedAlerts(activeKeys);
      return {
        ok: true,
        waiting: waitingPackages.length,
        activeAlerts: activeKeys.size,
        incidents: [...incidentState.values()].map((incident) => ({ ...incident })),
      };
    } catch (error) {
      log.warn("Operations supervisor inspection failed", { error });
      await alert("health:emergency:inspection", severity("emergency", `Operasyon gözcüsü veri okuyamadı: ${error.message}`), now().getTime()).catch(() => {});
      return { ok: false, error: error.message };
    } finally {
      running = false;
    }
  }

  function commandHelp() {
    return [
      "RESTOMAP operasyon denetçisi:",
      "/durum — sistem ve operasyon özeti",
      "/kritik — açık olaylar ve önem düzeyi",
      "/teshis — atama ve bağlantı neden analizi",
      "/bekleyenler — atama bekleyen paketler",
      "/kuryeler — canlı kurye özeti",
      "/kurye AD — kurye ayrıntısı",
      "/restoran AD — işletme ayrıntısı",
      "/platformlar — entegrasyon sağlığı",
      "/gunsonu — bugünün raporu",
      "/rapor hafta — 7 günlük analiz",
      "/tahmin — kapasite ve yoğunluk tahmini",
      "/paket PKT-123 — paket durumu",
      "/tekrarla PKT-123 — bekleyen pakette güvenli atama denemesi",
      "/yenidenata PKT-123 — onay kodlu güvenli müdahale",
      "/onayla 123456 — bekleyen müdahaleyi uygula",
      "/vazgec 123456 — bekleyen müdahaleyi iptal et",
      "",
      "Not: Bot teslim/iptal/kurye değiştirme işlemlerini kendiliğinden yapmaz.",
    ].join("\n");
  }

  async function executeCommand(text) {
    const [rawCommand, ...args] = String(text || "").trim().split(/\s+/);
    const command = rawCommand.toLocaleLowerCase("tr-TR").split("@")[0];
    const snapshot = await getSnapshot();
    const packages = snapshot?.packages || [];
    const couriers = snapshot?.couriers || [];
    if (["/start", "/yardim", "/help"].includes(command)) return commandHelp();
    if (command === "/durum") {
      const waiting = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId).length;
      const active = packages.filter((pkg) => ACTIVE_STATUSES.has(pkg.status)).length;
      const openIncidents = incidentState.size;
      return severity(openIncidents ? "warning" : "info", `Sistem çalışıyor. Aktif paket: ${active}, bekleyen: ${waiting}, canlı kurye: ${couriers.filter(isOnlineCourier).length}, açık olay: ${openIncidents}.`);
    }
    if (["/kritik", "/olaylar"].includes(command)) {
      const incidents = [...incidentState.values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
      if (!incidents.length) return severity("info", "Açık operasyon olayı yok.");
      return [
        severity("warning", `${incidents.length} açık operasyon olayı var.`),
        summarizeItems(incidents, (incident) => `• ${incident.level.toLocaleUpperCase("tr-TR")} · ${incident.title} · ${minutesSince(new Date(incident.firstSeenAt).toISOString(), now().getTime())} dk`, 12),
      ].join("\n");
    }
    if (["/teshis", "/teşhis"].includes(command)) {
      const waiting = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId);
      const reasonCounts = new Map();
      waiting.forEach((pkg) => {
        const reason = pkg.lastAssignmentError || pkg.assignmentReason || "uygun canlı kurye yok";
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
      });
      const stale = couriers.filter((courier) => isOnlineCourier(courier) && minutesSince(courier.lastLocationAt, now().getTime()) >= staleLocationMinutes);
      const activeOffline = packages.filter((pkg) => ACTIVE_STATUSES.has(pkg.status) && pkg.assignedCourierId)
        .filter((pkg) => !isOnlineCourier(couriers.find((courier) => courier.id === pkg.assignedCourierId)));
      const lines = [
        severity(waiting.length || activeOffline.length ? "warning" : "info", "Atama ve bağlantı teşhisi"),
        `• Bekleyen paket: ${waiting.length}`,
        `• Canlı kurye: ${couriers.filter(isOnlineCourier).length}`,
        `• Eski konumlu canlı kurye: ${stale.length}`,
        `• Çevrimdışı kuryede aktif paket: ${activeOffline.length}`,
      ];
      if (reasonCounts.size) {
        lines.push("• Atama nedenleri:");
        [...reasonCounts.entries()].slice(0, 6).forEach(([reason, count]) => lines.push(`  - ${count}× ${reason}`));
      }
      if (getHealthSnapshot) {
        const health = await getHealthSnapshot();
        const outbox = health?.integrations?.posentegra?.outbox?.counts || {};
        lines.push(`• Posentegra: ${health?.integrations?.posentegra?.outboundConfigured ? "bağlı" : "yapılandırılmamış"} · ${outbox.pending || 0} bekleyen · ${outbox.failed || 0} hatalı · ${outbox.dead_letter || 0} manuel`);
      }
      return lines.join("\n");
    }
    if (command === "/bekleyenler") {
      const waiting = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId);
      return waiting.length ? `${severity("warning", `${waiting.length} paket bekliyor.`)}\n${summarizeItems(waiting, (pkg) => `• ${packageLabel(pkg)} · ${restaurantLabel(pkg)}`, 10)}` : severity("info", "Atama bekleyen paket yok.");
    }
    if (command === "/kuryeler") {
      const online = couriers.filter(isOnlineCourier);
      return online.length ? `${severity("info", `${online.length} canlı kurye.`)}\n${summarizeItems(online, (c) => `• ${c.name || c.id} · ${c.status} · konum ${minutesSince(c.lastLocationAt, now().getTime())} dk`, 15)}` : severity("warning", "Şu anda canlı kurye yok.");
    }
    if (command === "/kurye") {
      const needle = normalizedSearch(commandArg(args));
      if (!needle) return "Kullanım: /kurye Kurye Adı";
      const matches = couriers.filter((courier) => normalizedSearch(`${courier.name} ${courier.id}`).includes(needle));
      if (!matches.length) return severity("warning", "Kurye bulunamadı.");
      if (matches.length > 1) return `${severity("warning", "Birden fazla kurye eşleşti.")}\n${summarizeItems(matches, (courier) => `• ${courier.name} · ${courier.id}`, 10)}`;
      const courier = matches[0];
      const assigned = packages.filter((pkg) => pkg.assignedCourierId === courier.id);
      return [
        severity("info", `${courier.name || courier.id} kurye özeti`),
        `• Durum: ${courier.status}`,
        `• Bölge: ${courier.zone || "belirsiz"}`,
        `• Son konum: ${minutesSince(courier.lastLocationAt, now().getTime())} dk önce`,
        `• Aktif paket: ${assigned.length}`,
        assigned.length ? summarizeItems(assigned, (pkg) => `  - ${packageLabel(pkg)} · ${statusLabel(pkg.status)}`, 6) : "• Üzerinde aktif paket yok",
      ].join("\n");
    }
    if (command === "/restoran") {
      const needle = normalizedSearch(commandArg(args));
      if (!needle) return "Kullanım: /restoran İşletme Adı";
      const liveMatches = packages.filter((pkg) => normalizedSearch(`${pkg.restaurantName} ${pkg.restaurantId}`).includes(needle));
      const analytics = getAnalyticsSnapshot ? await getAnalyticsSnapshot(7) : null;
      const historicalMatches = safeArray(analytics?.restaurants).filter((item) => normalizedSearch(`${item.name} ${item.id}`).includes(needle));
      const names = new Map();
      liveMatches.forEach((pkg) => names.set(pkg.restaurantId || pkg.restaurantName, pkg.restaurantName));
      historicalMatches.forEach((item) => names.set(item.id || item.name, item.name));
      if (!names.size) return severity("warning", "İşletme bulunamadı.");
      if (names.size > 1) return `${severity("warning", "Birden fazla işletme eşleşti.")}\n${[...names.values()].slice(0, 10).map((name) => `• ${name}`).join("\n")}`;
      const [restaurantKey, restaurantName] = [...names.entries()][0];
      const active = liveMatches.filter((pkg) => (pkg.restaurantId || pkg.restaurantName) === restaurantKey || pkg.restaurantName === restaurantName);
      const historical = historicalMatches.find((item) => (item.id || item.name) === restaurantKey || item.name === restaurantName);
      return [
        severity("info", `${restaurantName} işletme özeti`),
        `• Aktif paket: ${active.length}`,
        `• Atama bekleyen: ${active.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId).length}`,
        `• 7 günlük paket: ${historical?.total || 0}`,
        `• 7 günlük teslim/iptal: ${historical?.delivered || 0}/${historical?.cancelled || 0}`,
        active.length ? summarizeItems(active, (pkg) => `  - ${packageLabel(pkg)} · ${statusLabel(pkg.status)}`, 6) : "• Şu anda aktif paket yok",
      ].join("\n");
    }
    if (command === "/platformlar") {
      if (!getHealthSnapshot) return severity("warning", "Platform sağlık bilgisi kullanılamıyor.");
      const health = await getHealthSnapshot();
      const platform = health.platformHealth || {};
      const outbox = health.integrations?.posentegra?.outbox?.counts || {};
      return severity("info", `Platform hesapları: ${platform.connected || 0} bağlı, ${platform.warning || 0} uyarı, ${platform.error || 0} hata. Posentegra kuyruğu: ${outbox.pending || 0} bekleyen, ${outbox.failed || 0} başarısız.`);
    }
    if (command === "/gunsonu") {
      if (!getDailySummary) return severity("warning", "Gün sonu raporu kullanılamıyor.");
      const date = istanbulParts(now()).date;
      return dailyReport(await getDailySummary(date), date, "Anlık gün sonu raporu");
    }
    if (command === "/rapor") {
      if (!getAnalyticsSnapshot) return severity("warning", "Operasyon analizi kullanılamıyor.");
      const period = normalizedSearch(args[0]) === "bugun" || normalizedSearch(args[0]) === "bugün" ? 1 : 7;
      return analyticsReport(await getAnalyticsSnapshot(period), period === 1 ? "Bugünkü" : "Son 7 günlük");
    }
    if (command === "/tahmin") {
      if (!getAnalyticsSnapshot) return severity("warning", "Yoğunluk tahmini kullanılamıyor.");
      return forecastReport(await getAnalyticsSnapshot(7), snapshot);
    }
    if (command === "/paket") {
      if (!args[0]) return "Kullanım: /paket PKT-123";
      const pkg = findPackage ? await findPackage(args[0]) : packages.find((item) => packageLabel(item).toLowerCase() === args[0].toLowerCase());
      return pkg ? severity("info", `${packageLabel(pkg)} · ${restaurantLabel(pkg)} · ${pkg.status} · kurye: ${pkg.assignedCourierName || pkg.assignedCourierId || "atanmadı"}`) : severity("warning", "Paket bulunamadı.");
    }
    if (command === "/tekrarla") {
      if (!args[0]) return "Kullanım: /tekrarla PKT-123";
      if (!retryPackage) return severity("warning", "Güvenli tekrar deneme kullanılamıyor.");
      const result = await retryPackage(args[0]);
      await audit("telegram_safe_retry", { reference: args[0], ok: result.ok, message: result.message });
      return severity(result.ok ? "info" : "warning", result.message || "İşlem tamamlandı.");
    }
    if (["/yenidenata", "/mudahele", "/müdahale"].includes(command)) {
      if (!args[0]) return "Kullanım: /yenidenata PKT-123";
      if (!retryPackage) return severity("warning", "Güvenli müdahale kullanılamıyor.");
      const pkg = findPackage ? await findPackage(args[0]) : packages.find((item) => normalizedSearch(packageLabel(item)) === normalizedSearch(args[0]));
      if (!pkg) return severity("warning", "Paket bulunamadı; müdahale oluşturulmadı.");
      if (!WAITING_STATUSES.has(pkg.status) || pkg.assignedCourierId) {
        return severity("warning", `${packageLabel(pkg)} ${statusLabel(pkg.status)} durumunda; güvenli yeniden atama koşulu yok.`);
      }
      pruneApprovals(now().getTime());
      let code = String(createApprovalCode());
      while (pendingApprovals.has(code) || completedApprovals.has(code)) code = String(createApprovalCode());
      pendingApprovals.set(code, {
        type: "retry_assignment",
        reference: packageLabel(pkg),
        packageId: pkg.id,
        createdAt: now().getTime(),
        expiresAt: now().getTime() + approvalTtlMinutes * 60_000,
      });
      await audit("telegram_approval_requested", { code, packageId: pkg.id, reference: packageLabel(pkg) });
      return [
        severity("warning", `${packageLabel(pkg)} için güvenli atama yeniden denemesi hazır.`),
        `Uygulamak için ${approvalTtlMinutes} dakika içinde: /onayla ${code}`,
        `İptal etmek için: /vazgec ${code}`,
        "Onay verilene kadar paket değiştirilmez.",
      ].join("\n");
    }
    if (command === "/onayla") {
      const code = String(args[0] || "");
      if (!code) return "Kullanım: /onayla 123456";
      pruneApprovals(now().getTime());
      if (completedApprovals.has(code)) return severity("info", "Bu onay daha önce işlendi; ikinci kez çalıştırılmadı.");
      const approval = pendingApprovals.get(code);
      if (!approval) return severity("warning", "Onay kodu bulunamadı veya süresi doldu.");
      // Aynı Telegram güncellemesi tekrar gelse bile işlem ikinci kez çalışmasın.
      pendingApprovals.delete(code);
      completedApprovals.set(code, now().getTime());
      const result = await retryPackage(approval.reference);
      await audit("telegram_approval_executed", { code, packageId: approval.packageId, ok: result.ok, message: result.message });
      return severity(result.ok ? "info" : "warning", result.message || "Onaylı işlem tamamlandı.");
    }
    if (["/vazgec", "/reddetonay"].includes(command)) {
      const code = String(args[0] || "");
      if (!code) return "Kullanım: /vazgec 123456";
      const approval = pendingApprovals.get(code);
      if (!approval) return severity("warning", "Onay kodu bulunamadı veya süresi doldu.");
      pendingApprovals.delete(code);
      completedApprovals.set(code, now().getTime());
      await audit("telegram_approval_cancelled", { code, packageId: approval.packageId });
      return severity("info", `${approval.reference} için bekleyen müdahale iptal edildi.`);
    }
    return commandHelp();
  }

  async function pollCommands() {
    if (commandRunning || !telegram?.configured?.() || typeof telegram.getUpdates !== "function") return { skipped: true };
    commandRunning = true;
    try {
      const result = await telegram.getUpdates({ offset: commandOffset ?? undefined, timeoutSeconds: 0 });
      if (!result.ok) return result;
      const updates = result.updates || [];
      // İlk bağlantıda eski komutları çalıştırma; sadece imleci güncele taşı.
      if (commandOffset === null) {
        if (updates.length) commandOffset = Math.max(...updates.map((item) => Number(item.update_id) || 0)) + 1;
        else commandOffset = 0;
        return { ok: true, initialized: true };
      }
      for (const update of updates) {
        commandOffset = Math.max(commandOffset, Number(update.update_id || 0) + 1);
        const message = update.message;
        if (!message?.text?.startsWith("/")) continue;
        if (String(message.chat?.id || "") !== String(telegram.authorizedChatId?.() || "")) continue;
        try {
          await telegram.sendMessage(await executeCommand(message.text));
        } catch (error) {
          await telegram.sendMessage(severity("critical", `Komut çalıştırılamadı: ${error.message}`));
        }
      }
      return { ok: true, processed: updates.length };
    } finally {
      commandRunning = false;
    }
  }

  function start() {
    if (timer || process.env.DELIVERA_SUPERVISOR_ENABLED === "false") return;
    timer = setInterval(() => void inspect(), intervalMs);
    timer.unref?.();
    if (telegram?.configured?.() && typeof telegram.getUpdates === "function") {
      commandTimer = setInterval(() => void pollCommands(), commandPollMs);
      commandTimer.unref?.();
      void pollCommands();
    }
    void inspect();
    log.info("Operations supervisor started", { intervalMs, commandPollMs, telegramConfigured: telegram.configured() });
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (commandTimer) clearInterval(commandTimer);
    timer = null;
    commandTimer = null;
  }

  function getState() {
    return {
      incidents: [...incidentState.values()].map((incident) => ({ ...incident })),
      pendingApprovals: [...pendingApprovals.entries()].map(([code, item]) => ({ code, ...item })),
      remediationKeys: [...remediationState.keys()],
    };
  }

  return { inspect, pollCommands, executeCommand, start, stop, getState };
}

module.exports = { createOperationsSupervisor, istanbulParts, severity };
