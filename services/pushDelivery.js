"use strict";

// Transport failures are contained here; order and accounting writes never await push.
function createPushDelivery({ send, success, failure, invalid, active = () => true, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return async function deliver(row, payload) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!await active(row)) return false;
      try {
        await send(JSON.parse(row.subscription_json), JSON.stringify(payload), { TTL: 300, urgency: "high", timeout: 10000 });
        await success(row);
        return true;
      } catch (error) {
        const status = Number(error?.statusCode);
        if ([404, 410].includes(status)) {
          await invalid(row);
          return false;
        }
        await failure(row, error);
        if ((status && status !== 429 && status < 500) || attempt === 2) return false;
        await wait(500 * (2 ** attempt));
      }
    }
    return false;
  };
}

function pushPayload(role, event) {
  const eventType = event.type || "workspace-update";
  const packageId = event.packageId || event.orderId || "";
  const query = new URLSearchParams({ notifications: "1" });
  if (packageId) query.set("package", packageId);
  return {
    title: eventType.includes("push-test") ? "RESTOMAP Bildirim Testi" : "RESTOMAP",
    body: event.message || "Yeni bildiriminiz var.",
    role,
    eventType,
    packageId,
    tag: `restomap:${role}:${eventType}:${packageId || event.courierId || event.restaurantId || "general"}`,
    url: `/${role}.html?${query}`,
  };
}

function recipients(role, event) {
  if (role === "admin" || (event.announcementId && [role, "all"].includes(event.targetRole))) return null;
  return [...new Set([
    event[`${role}Id`],
    event.targetRole === role ? event.targetId : null,
    ...(Array.isArray(event.audiences) ? event.audiences.filter((item) => item?.role === role).map((item) => item.id) : []),
  ].filter(Boolean))];
}

module.exports = { createPushDelivery, pushPayload, recipients };
