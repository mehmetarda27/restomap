"use strict";
let messaging;
function getMessaging() {
  if (messaging) return messaging;
  if (!process.env.RESTOMAP_FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const error = new Error("Firebase credentials are not configured");
    error.statusCode = 503;
    throw error;
  }
  const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
  const credential = process.env.RESTOMAP_FIREBASE_SERVICE_ACCOUNT
    ? cert(JSON.parse(process.env.RESTOMAP_FIREBASE_SERVICE_ACCOUNT)) : applicationDefault();
  const app = initializeApp({ credential }, "restomap-push");
  messaging = require("firebase-admin/messaging").getMessaging(app);
  return messaging;
}

async function send(subscription, payload) {
  try {
    return await getMessaging().send({
      token: subscription.token,
      notification: { title: payload.title, body: payload.body },
      data: { url: payload.url, role: payload.role, eventType: payload.eventType || "workspace-update", packageId: payload.packageId || "" },
      android: { priority: "high", ttl: 300000, notification: { tag: payload.tag, channelId: "restomap-operations" } },
    });
  } catch (error) {
    const code = error.code;
    if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(code)) error.statusCode = 410;
    else if (["messaging/invalid-argument", "messaging/mismatched-credential", "messaging/authentication-error"].includes(code)) error.statusCode = 400;
    throw error;
  }
}
module.exports = { send };
