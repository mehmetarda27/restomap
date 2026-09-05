(() => {
  "use strict";

  const TOKEN_KEY = "kuryeTakipCourierToken";
  const REFRESH_KEY = "kuryeTakipCourierRefreshToken";
  const ASSIGNMENT_SIGNAL_KEY = (() => {
    const currentKey = "restomapCourierAssignmentSignals";
    const legacyKey = "deliveraCourierAssignmentSignals";
    if (localStorage.getItem(currentKey) === null && localStorage.getItem(legacyKey) !== null) {
      localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
    }
    return currentKey;
  })();
  const ASSIGNMENT_SIGNAL_TTL_MS = 30 * 60 * 1000;
  const ASSIGNMENT_REMINDER_MS = 45 * 1000;
  const MAX_ASSIGNMENT_SIGNALS = 2;
  const CLOSED = new Set(["delivered", "failed", "cancelled"]);
  const route = location.pathname;
  const reportView = new URLSearchParams(location.search).get("view") || "overview";
  let workspace = null;
  let pollId = null;
  let mapWatchId = null;
  let mapHeartbeatId = null;
  let lastKnownCourierCoords = null;
  let gpsObservedAt = 0;
  let followCourier = true;
  let gpsStatusControl = null;
  let routeRetryAt = 0;
  let routeRequestedAt = 0;
  let routeGeometry = [];
  let locationHeartbeatBusy = false;
  let leafletLoader = null;
  let leafletMap = null;
  let courierMapMarker = null;
  let destinationMapMarkers = [];
  let navigationRouteLayer = null;
  let navigationMapControl = null;
  let navigationMapControlElement = null;
  let navigationRouteAbortController = null;
  let navigationRouteRequestId = 0;
  let lastNavigationRouteKey = "";
  let lastNavigationRouteSummary = "";
  let lastDestinationMapKey = "";
  let courierMapPoll = null;
  let courierMapRefreshTimer = null;
  let courierMapRefreshBusy = false;
  let reportPeriod = "daily";
  let eventStream = null;
  let lastLocationPushAt = 0;
  let connectionBusy = false;
  let assignmentAlertTimer = null;
  let assignmentTitleTimer = null;
  let assignmentAudioContext = null;
  let lastAssignmentSignalAt = 0;
  let assignmentSignalCount = 0;
  let assignmentSnapshot = new Map();
  let pushInitialized = false;
  const originalDocumentTitle = document.title;

  function revealCourierApp() {
    window.clearTimeout(globalThis.__deliveraCourierBootFallback);
    document.documentElement.classList.remove("delivera-booting");
  }

  const token = () => localStorage.getItem(TOKEN_KEY) || "";
  const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const money = (value) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(Number(value || 0));
  const all = (selector) => [...document.querySelectorAll(selector)];
  const textNodes = (value) => all("body *").filter((element) => element.children.length === 0 && element.textContent.trim() === value);
  const containsText = (value) => all("body *").filter((element) => element.children.length === 0 && element.textContent.trim().includes(value));

  function saveAuth(auth = {}) {
    const accessToken = auth.token || auth.accessToken || "";
    const refreshToken = auth.refreshToken || "";
    if (accessToken) localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  }

  async function api(path, options = {}, retry = true) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 && retry && path !== "/api/courier/login") {
      const refreshToken = localStorage.getItem(REFRESH_KEY) || "";
      if (refreshToken) {
        const refreshResponse = await fetch("/api/courier/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshResponse.ok) {
          saveAuth(await refreshResponse.json());
          return api(path, options, false);
        }
      }
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/courier/login") logout(false);
      throw new Error(payload.error || payload.message || "İşlem tamamlanamadı.");
    }
    return payload;
  }

  function addIntegrationStyle() {
    const style = document.createElement("style");
    style.textContent = `
      .delivera-action{min-height:48px;border:0;border-radius:10px;background:#0061a4;color:#fff;padding:0 18px;font-weight:700}
      .delivera-modal{position:fixed;inset:0;z-index:9998;background:#001d36aa;display:grid;place-items:end center;padding:16px;backdrop-filter:blur(3px)}.delivera-sheet{width:min(100%,520px);max-height:78vh;overflow:auto;background:#f7f9fc;border-radius:24px 24px 12px 12px;padding:18px;box-shadow:0 20px 60px #0005}.delivera-sheet-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.delivera-sheet-head h2{font:700 22px 'Hanken Grotesk',sans-serif;margin:0}.delivera-close{width:42px;height:42px;border:0;border-radius:50%;font-size:24px}.delivera-package{background:#fff;border:1px solid #d8dadd;border-radius:12px;padding:14px;margin:10px 0}.delivera-package header{display:flex;justify-content:space-between;gap:10px}.delivera-package h3{margin:3px 0;font-size:17px}.delivera-package small{color:#66717d}.delivera-package p{font-size:13px;margin:8px 0}.delivera-package select{width:100%;height:46px;border:1px solid #bfc7d4;border-radius:9px;padding:0 10px;background:#fff}.delivera-package button{width:100%;margin-top:8px}.delivera-badge{background:#d1e4ff;color:#00497d;border-radius:6px;padding:5px 8px;font-size:10px;font-weight:700}.delivera-toast{position:fixed;z-index:10000;left:50%;bottom:100px;transform:translateX(-50%);max-width:90%;background:#2d3133;color:#fff;padding:11px 16px;border-radius:9px;box-shadow:0 8px 30px #0004;font:600 13px Inter,sans-serif}.delivera-toast.error{background:#ba1a1a}.delivera-profile-form input{width:100%;height:48px;border:1px solid #bfc7d4;border-radius:9px;padding:0 12px;margin:5px 0 12px}.delivera-profile-form label{font-size:12px;font-weight:700}.delivera-profile-form button{width:100%}
      body.delivera-mobile-layout>aside,body.delivera-mobile-layout main>aside{display:none!important}
      body.delivera-mobile-layout header.md\\:hidden,body.delivera-mobile-layout nav.md\\:hidden{display:flex!important}
      body.delivera-mobile-layout .hidden.md\\:flex{display:none!important}
      body.delivera-mobile-layout main{max-width:480px!important;margin-left:auto!important;margin-right:auto!important;display:flex!important;flex-direction:column!important}
      body.delivera-mobile-layout main>div{margin-left:0!important}
      body.delivera-mobile-layout .md\\:px-8{padding-left:1rem!important;padding-right:1rem!important}
      body.delivera-mobile-layout .md\\:pt-8{padding-top:0!important}
      body.delivera-mobile-layout>nav.fixed{width:min(100%,480px)!important;left:50%!important;transform:translateX(-50%)!important}
      html:has(body.delivera-mobile-layout),body.delivera-mobile-layout{width:100%!important;height:100%!important;min-height:0!important;overflow:hidden!important}
      body.delivera-mobile-layout{display:block!important;background:#e9edf2!important}
      .delivera-app-shell{position:relative!important;transform:translateZ(0);width:min(100%,480px)!important;height:100dvh!important;min-height:100dvh!important;margin:0 auto!important;overflow:hidden!important;background:#f7f9fc!important;display:flex!important;flex-direction:column!important;box-shadow:0 0 28px rgba(0,29,54,.16)}
      .delivera-app-shell>main{width:100%!important;max-width:480px!important;height:auto!important;min-height:0!important;flex:1 1 auto!important;margin:0!important;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior-y:contain;scrollbar-gutter:stable;-webkit-overflow-scrolling:touch;touch-action:pan-y}
      .delivera-app-shell>main::-webkit-scrollbar{width:8px}.delivera-app-shell>main::-webkit-scrollbar-track{background:#e7ebef}.delivera-app-shell>main::-webkit-scrollbar-thumb{background:#7b828a;border:2px solid #e7ebef;border-radius:999px}.delivera-app-shell>main{scrollbar-width:thin;scrollbar-color:#7b828a #e7ebef}
      .delivera-app-shell>header{width:100%!important;flex:0 0 auto!important}
      .delivera-app-shell>nav.fixed{width:100%!important;left:0!important;right:0!important;transform:none!important}
      .delivera-app-shell>.absolute.inset-0{width:100%!important}
      .delivera-notification-button{position:relative;width:48px;height:48px;border:0;border-radius:12px;background:#fff;color:#0061a4;display:grid;place-items:center;box-shadow:0 5px 16px #001d3626}.delivera-notification-badge{position:absolute;right:-5px;top:-5px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#ba1a1a;color:#fff;font:700 11px Inter,sans-serif;display:grid;place-items:center}.delivera-notification-badge:empty{display:none}
      .delivera-offer-modal{z-index:10020;background:#001d36d9;backdrop-filter:blur(7px)}.delivera-offer-sheet{width:min(100%,460px);max-height:92vh;overflow:auto;background:#fff;border-radius:22px;padding:20px;box-shadow:0 28px 80px #0008;border:3px solid #2196f3}.delivera-offer-alert{display:flex;align-items:center;gap:12px;padding:14px;border-radius:14px;background:#d1e4ff;color:#003258;margin-bottom:14px}.delivera-offer-alert .material-symbols-outlined{font-size:34px}.delivera-offer-alert h2{font:800 21px 'Hanken Grotesk',sans-serif;margin:0}.delivera-offer-alert p{font-size:12px;margin:3px 0 0}.delivera-offer-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.delivera-offer-item{padding:11px;border-radius:10px;background:#f1f4f7;min-width:0}.delivera-offer-item.wide{grid-column:1/-1}.delivera-offer-item span{display:block;color:#66717d;font-size:10px;margin-bottom:4px}.delivera-offer-item strong{display:block;font-size:13px;overflow-wrap:anywhere}.delivera-offer-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.delivera-offer-actions button{min-height:52px;border:0;border-radius:11px;font-weight:800}.delivera-offer-actions .accept{background:#0061a4;color:#fff}.delivera-offer-actions .reject{background:#ffdad6;color:#ba1a1a}.delivera-push-enable{width:100%;min-height:44px;margin-top:12px;border:1px solid #0061a4;border-radius:10px;background:#fff;color:#0061a4;font-weight:700}.delivera-notification-list{display:grid;gap:9px}.delivera-notification-item{padding:12px;border-radius:10px;background:#f1f4f7;border-left:4px solid #2196f3}.delivera-notification-item strong{display:block;font-size:12px}.delivera-notification-item time{display:block;color:#66717d;font-size:10px;margin-top:5px}
      .delivera-report-detail{display:grid;gap:12px}.delivera-detail-title{display:flex;align-items:center;gap:10px;margin:0}.delivera-detail-title span{color:#0061a4}.delivera-detail-card{background:#fff;border:1px solid #d8dadd;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(25,28,30,.05)}.delivera-detail-card h3{font:600 16px 'Hanken Grotesk',sans-serif;margin:0 0 12px}.delivera-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.delivera-detail-metric{background:#f2f4f7;border-radius:9px;padding:12px;min-width:0}.delivera-detail-metric span{display:block;color:#66717d;font-size:11px;margin-bottom:5px}.delivera-detail-metric strong{display:block;color:#191c1e;font:700 15px 'JetBrains Mono',monospace;overflow-wrap:anywhere}.delivera-detail-list{display:grid;gap:8px}.delivera-detail-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:11px 0;border-bottom:1px solid #eceef1}.delivera-detail-row:last-child{border-bottom:0}.delivera-detail-row span{font-size:12px;color:#66717d}.delivera-detail-row strong{text-align:right;font-size:12px}.delivera-detail-empty{color:#66717d;font-size:13px;padding:8px 0}.delivera-report-back{width:100%;min-height:46px;border:1px solid #0061a4;border-radius:10px;background:#fff;color:#0061a4;font-weight:700}
      .map-bg.leaflet-container{z-index:0;background:#dce9f4;font-family:Inter,sans-serif}.map-bg .leaflet-control-zoom{margin-top:12px}.map-bg .leaflet-control-attribution{font-size:8px}.delivera-leaflet-courier-icon,.delivera-leaflet-restaurant-icon,.delivera-leaflet-customer-icon{background:transparent!important;border:0!important;overflow:visible!important}.delivera-courier-dot{position:relative;width:26px;height:26px;border:4px solid #fff;border-radius:50%;background:#0878d1;box-shadow:0 3px 12px #003b6670;display:block}.delivera-courier-dot::after{content:"";position:absolute;inset:50% auto auto 50%;width:54px;height:54px;border-radius:50%;background:#2196f34d;transform:translate(-50%,-50%);animation:delivera-marker-pulse 1.8s ease-out infinite}.delivera-restaurant-dot,.delivera-customer-dot{position:relative;width:38px;height:38px;border:3px solid #fff;border-radius:50%;color:#fff;display:grid;place-items:center;cursor:pointer}.delivera-restaurant-dot{background:#f57c00;box-shadow:0 3px 12px #4d260066}.delivera-customer-dot{background:#b3261e;box-shadow:0 3px 12px #5f120d70}.delivera-restaurant-dot .material-symbols-outlined,.delivera-customer-dot .material-symbols-outlined{font-size:20px}.delivera-restaurant-marker-label{position:absolute;left:50%;top:42px;transform:translateX(-50%);max-width:145px;width:max-content;padding:5px 8px;border-radius:8px;background:#fff;color:#263238;box-shadow:0 2px 9px #0003;font:700 11px Inter,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.delivera-side-menu{transition:transform .22s ease}.delivera-side-menu-trigger{cursor:pointer;user-select:none}.delivera-side-menu.is-collapsed{transform:translateX(calc(100% + 13px))}.delivera-side-menu.is-collapsed .delivera-side-menu-trigger{transform:translateY(-50%)}@keyframes delivera-marker-pulse{0%{transform:translate(-50%,-50%) scale(.45);opacity:.8}100%{transform:translate(-50%,-50%) scale(1.35);opacity:0}}.delivera-shift-start{width:100%;min-height:82px;border:1px solid #5bd477;border-radius:12px;background:#d7f8de;color:#005313;padding:14px 18px;display:flex;align-items:center;gap:14px;text-align:left}.delivera-shift-start .material-symbols-outlined{width:50px;height:50px;border-radius:10px;background:#006e1c;color:#fff;display:grid;place-items:center;font-size:30px}.delivera-shift-start strong{display:block;font-size:16px}.delivera-shift-start small{display:block;color:#276636;margin-top:3px}.delivera-shift-start:disabled{opacity:.6}
      .map-bg .leaflet-control-zoom{margin-top:150px!important;margin-left:12px!important}.delivera-package-meta{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:10px 0}.delivera-package-meta span{padding:8px;border-radius:8px;background:#f1f4f7;color:#46515c;font-size:11px}.delivera-customer-phone{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;padding:10px;border:1px solid #c7d9ee;border-radius:8px;background:#f7fbff;color:#263238;font-size:12px}.delivera-customer-phone span{color:#66717d;font-size:10px}.delivera-customer-phone strong{font:700 13px 'JetBrains Mono',monospace;overflow-wrap:anywhere;text-align:right}.delivera-package-address{padding:10px;border-radius:8px;background:#eef6ff;color:#263238;font-size:12px}.delivera-package-field{display:grid;gap:5px;margin-top:10px;font-size:11px;font-weight:700}.delivera-package-field select,.delivera-package-field input{width:100%;height:44px;border:1px solid #bfc7d4;border-radius:9px;padding:0 10px;background:#fff}.delivera-package-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.delivera-package-actions button{min-height:44px;border:0;border-radius:9px;font-weight:700}.delivera-package-actions .primary{background:#0061a4;color:#fff}.delivera-package-actions .secondary{background:#e1efff;color:#00497d}.delivera-package-actions .danger{background:#ffdad6;color:#ba1a1a}.delivera-package-actions .success{background:#c8f7d3;color:#006e1c}.delivera-package-contact{display:flex;gap:8px;margin-top:8px}.delivera-package-contact a{flex:1;display:flex;justify-content:center;align-items:center;min-height:40px;border:1px solid #0061a4;border-radius:8px;color:#0061a4;font-weight:700;font-size:12px;text-decoration:none}.delivera-chart-bars{position:absolute;left:28px;right:0;bottom:24px;top:3px;display:flex;align-items:flex-end;justify-content:space-around;gap:8px}.delivera-chart-bar{flex:1;max-width:28px;min-height:3px;border-radius:7px 7px 2px 2px;background:linear-gradient(#2196f3,#0061a4);transition:height .25s ease}.delivera-chart-bar[title="0"]{opacity:.22}
      .map-bg .leaflet-bottom.leaflet-left{left:12px;right:12px;bottom:190px}.map-bg .leaflet-bottom.leaflet-left .leaflet-control{margin:0}.delivera-navigation-card{box-sizing:border-box;width:min(330px,calc(100vw - 48px));display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px 12px;border:1px solid #b9d7f5;border-radius:14px;background:#fffffff2;color:#15324a;box-shadow:0 9px 28px #001d3640;backdrop-filter:blur(7px);font-family:Inter,sans-serif}.delivera-navigation-card[hidden]{display:none}.delivera-navigation-card small{display:block;color:#526675;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.delivera-navigation-card strong{display:block;margin-top:3px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.delivera-navigation-card span{display:block;margin-top:2px;color:#526675;font-size:11px}.delivera-navigation-card button{min-width:96px;min-height:42px;border:0;border-radius:10px;background:#0061a4;color:#fff;font-size:11px;font-weight:800;box-shadow:0 4px 12px #0061a43d}.delivera-navigation-card button:active{transform:translateY(1px)}
      .delivera-history-date{display:flex;align-items:center;gap:5px;color:#66717d;font-size:11px;margin:8px 0}.delivera-history-details{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.delivera-history-details>div{padding:9px;border-radius:8px;background:#f1f4f7;min-width:0}.delivera-history-details span{display:block;color:#66717d;font-size:10px;margin-bottom:3px}.delivera-history-details strong{display:block;font-size:12px;overflow-wrap:anywhere}
      .delivera-day-close-summary{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:12px 0}.delivera-day-close-summary>div{padding:12px;border-radius:10px;background:#eef6ff}.delivera-day-close-summary span{display:block;color:#66717d;font-size:10px;margin-bottom:5px}.delivera-day-close-summary strong{display:block;color:#191c1e;font:700 14px 'JetBrains Mono',monospace}.delivera-day-close-note{box-sizing:border-box;width:100%;min-height:76px;resize:vertical;margin:8px 0 4px;padding:11px;border:1px solid #bfc7d4;border-radius:9px;background:#fff;font:500 13px Inter,sans-serif}.delivera-day-close-warning{padding:10px 12px;border-radius:9px;background:#fff3cd;color:#755b00;font-size:12px}.delivera-day-close-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.delivera-day-close-actions button{min-height:48px;border:0;border-radius:9px;font-weight:800}.delivera-day-close-cancel{background:#e8eaed;color:#3f484f}.delivera-day-close-submit{background:#13852d;color:#fff}.delivera-day-close-submit:disabled{opacity:.55}
      .restomap-gps-stale .delivera-courier-dot::after{animation:none;opacity:0}
      @media(max-width:480px){.delivera-app-shell{box-shadow:none}}
    `;
    document.head.append(style);
  }

  function installAppShell() {
    if (document.querySelector(".delivera-app-shell")) return;
    const shell = document.createElement("div");
    shell.className = "delivera-app-shell";
    const movable = [...document.body.children].filter((element) =>
      element.tagName !== "SCRIPT" &&
      element.tagName !== "TEMPLATE" &&
      element.id !== "courierRuntimeHooks" &&
      !element.classList.contains("delivera-login")
    );
    movable.forEach((element) => shell.append(element));
    document.body.prepend(shell);
    window.scrollTo(0, 0);
    const main = shell.querySelector("main");
    if (main) main.scrollTop = 0;
  }

  function toast(message, kind = "") {
    document.querySelector(".delivera-toast")?.remove();
    const item = document.createElement("div");
    item.className = `delivera-toast ${kind}`;
    item.textContent = message;
    document.body.append(item);
    window.setTimeout(() => item.remove(), 3200);
  }

  function notificationPermission() {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  }

  function requestCourierNotificationPermission() {
    if (typeof Notification === "undefined") return Promise.resolve("unsupported");
    if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
    try { return Promise.resolve(Notification.requestPermission()); }
    catch { return Promise.resolve("default"); }
  }

  function pushApplicationServerKey(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  async function initializeCourierPush(options = {}) {
    if (!token()) return false;
    try {
      const { registerPush } = await import("/push-client.js");
      pushInitialized = await registerPush("courier", api, options.requestPermission);
      return pushInitialized;
    } catch (error) {
      if (options.requestPermission) toast(error.message || "Bildirimler etkinleştirilemedi.", "error");
      return false;
    }
  }

  function unlockAssignmentAudio() {
    try {
      assignmentAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (assignmentAudioContext.state === "suspended") assignmentAudioContext.resume().catch(() => {});
    } catch {}
  }

  function playAssignmentSignal() {
    if (Date.now() - lastAssignmentSignalAt < 1500) return;
    lastAssignmentSignalAt = Date.now();
    unlockAssignmentAudio();
    const context = assignmentAudioContext;
    if (context?.state === "running") {
      [880, 1174, 1320, 1174, 880, 1320].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + index * 0.24;
        oscillator.frequency.value = frequency;
        oscillator.type = "sine";
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.2);
      });
    }
    navigator.vibrate?.([350, 120, 350, 120, 700]);
  }

  function stopAssignmentAttention() {
    window.clearInterval(assignmentAlertTimer);
    window.clearInterval(assignmentTitleTimer);
    assignmentAlertTimer = null;
    assignmentTitleTimer = null;
    assignmentSignalCount = 0;
    document.title = originalDocumentTitle;
  }

  function shouldSignalAssignment(pkg) {
    const signature = `${pkg.id}|${pkg.assignedAt || ""}`;
    let recent = {};
    try { recent = JSON.parse(localStorage.getItem(ASSIGNMENT_SIGNAL_KEY) || "{}"); } catch {}
    const cutoff = Date.now() - ASSIGNMENT_SIGNAL_TTL_MS;
    recent = Object.fromEntries(Object.entries(recent).filter(([, at]) => Number(at) >= cutoff));
    if (Number(recent[signature]) >= cutoff) return false;
    recent[signature] = Date.now();
    localStorage.setItem(ASSIGNMENT_SIGNAL_KEY, JSON.stringify(recent));
    return true;
  }

  function startAssignmentAttention(pkg) {
    playAssignmentSignal();
    assignmentSignalCount = 1;
    window.clearInterval(assignmentAlertTimer);
    const maxSignals = window.DeliveraNativeApp ? 1 : MAX_ASSIGNMENT_SIGNALS;
    assignmentAlertTimer = window.setInterval(() => {
      if (assignmentSignalCount >= maxSignals) {
        window.clearInterval(assignmentAlertTimer);
        assignmentAlertTimer = null;
        return;
      }
      assignmentSignalCount += 1;
      playAssignmentSignal();
    }, ASSIGNMENT_REMINDER_MS);
    window.clearInterval(assignmentTitleTimer);
    let visible = false;
    assignmentTitleTimer = window.setInterval(() => { visible = !visible; document.title = visible ? "🔔 YENİ PAKETİ KABUL ET" : originalDocumentTitle; }, 850);
    if (!pushInitialized && notificationPermission() === "granted") {
      navigator.serviceWorker?.getRegistration("/").then((registration) => registration?.showNotification("RESTOMAP - Yeni Paket", {
        body: `${pkg.restaurantName || "Restoran"} - ${pkg.deliveryAddress || pkg.address || "Paket detayını açın"}`,
        tag: `delivera-package-${pkg.id}`,
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 600],
        data: { url: `/courier.html?package=${encodeURIComponent(pkg.id)}`, packageId: pkg.id },
      })).catch(() => {});
    }
  }

  async function performOfferAction(pkg, action, modal) {
    const buttons = modal.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      workspace = action === "accept"
        ? await api(`/api/courier/packages/${encodeURIComponent(pkg.id)}/status`, { method: "PATCH", body: JSON.stringify({ status: "accepted_by_courier" }) })
        : await api(`/api/courier/packages/${encodeURIComponent(pkg.id)}/reject`, { method: "POST", body: "{}" });
      stopAssignmentAttention();
      modal.remove();
      toast(action === "accept" ? "Paket kabul edildi." : "Paket reddedildi; sıradaki en yakın kurye aranıyor.");
      processIncomingAssignments(workspace);
      hydrate();
    } catch (error) {
      toast(error.message || "Paket işlemi tamamlanamadı.", "error");
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function showAssignmentOffer(pkg) {
    const current = [...document.querySelectorAll(".delivera-offer-modal")].find((item) => item.dataset.packageId === pkg.id);
    if (current) return;
    document.querySelector(".delivera-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "delivera-modal delivera-offer-modal";
    modal.dataset.packageId = pkg.id;
    modal.innerHTML = `<section class="delivera-offer-sheet" role="alertdialog" aria-modal="true"><div class="delivera-offer-alert"><span class="material-symbols-outlined notranslate" translate="no">notifications_active</span><div><h2>Yeni Paket Düştü</h2><p>Kabul veya red işlemi yapmadan bu bildirim kapanmaz.</p></div></div><div class="delivera-offer-grid"><div class="delivera-offer-item"><span>Paket</span><strong>${esc(pkg.trackingNo || pkg.id)}</strong></div><div class="delivera-offer-item"><span>Mesafe</span><strong>${Number.isFinite(Number(pkg.distanceKm)) ? `${Number(pkg.distanceKm).toFixed(1)} km` : esc(pkg.eta || "Hesaplanıyor")}</strong></div><div class="delivera-offer-item wide"><span>Restoran</span><strong>${esc(pkg.restaurantName || "Restoran")}</strong></div><div class="delivera-offer-item wide"><span>Teslimat adresi</span><strong>${esc(pkg.customerAddress || pkg.deliveryAddress || pkg.address || "Adres bekleniyor")}</strong></div><div class="delivera-offer-item"><span>Müşteri</span><strong>${esc(pkg.recipient || "Müşteri")}</strong></div><div class="delivera-offer-item"><span>Ödeme</span><strong>${esc(pkg.paymentMethod || "Belirtilmedi")}</strong></div></div>${notificationPermission() !== "granted" ? '<button type="button" class="delivera-push-enable">Telefon Bildirimlerini ve Sesi Aç</button>' : ""}<div class="delivera-offer-actions"><button type="button" class="reject">Paketi Reddet</button><button type="button" class="accept">Paketi Kabul Et</button></div></section>`;
    modal.querySelector(".delivera-push-enable:not([data-read-all])")?.addEventListener("click", async () => { unlockAssignmentAudio(); const enabled = await initializeCourierPush({ requestPermission: true }); if (enabled) modal.querySelector(".delivera-push-enable:not([data-read-all])")?.remove(); });
    modal.querySelector(".accept").addEventListener("click", () => performOfferAction(pkg, "accept", modal));
    modal.querySelector(".reject").addEventListener("click", () => performOfferAction(pkg, "reject", modal));
    document.body.append(modal);
  }

  function processIncomingAssignments(nextWorkspace) {
    const nextSnapshot = new Map();
    const assigned = (nextWorkspace?.packages || []).filter((pkg) => pkg.status === "assigned");
    assigned.forEach((pkg) => {
      const signature = `${pkg.status}|${pkg.assignedAt || ""}`;
      nextSnapshot.set(pkg.id, signature);
      if (assignmentSnapshot.get(pkg.id) !== signature && shouldSignalAssignment(pkg)) {
        startAssignmentAttention(pkg);
        toast(`${pkg.restaurantName || "Restoran"} tarafından yeni paket düştü.`, "success");
      }
    });
    assignmentSnapshot = nextSnapshot;
    if (assigned[0]) showAssignmentOffer(assigned[0]);
    else {
      document.querySelector(".delivera-offer-modal")?.remove();
      stopAssignmentAttention();
    }
  }

  function showNotificationCenter() {
    if ((workspace?.packages || []).some((pkg) => pkg.status === "assigned")) return processIncomingAssignments(workspace);
    document.querySelector(".delivera-modal")?.remove();
    const notifications = workspace?.notifications || [];
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>Bildirim Merkezi</h2><button class="delivera-close" type="button">×</button></div>${notificationPermission() !== "granted" ? '<button type="button" class="delivera-push-enable">Telefon Bildirimlerini ve Sesi Aç</button>' : ""}<button type="button" class="delivera-push-enable" data-read-all ${(workspace?.unreadNotificationCount ?? notifications.some((item) => item.unread !== false && !item.readAt)) > 0 ? "" : "disabled"}>Tümünü Okundu İşaretle</button><div class="delivera-notification-list">${notifications.length ? notifications.map((item) => `<article class="delivera-notification-item"><strong>${esc(item.message)}</strong><time>${new Date(item.createdAt).toLocaleString("tr-TR")}${item.readAt ? ` · Okundu ${new Date(item.readAt).toLocaleString("tr-TR")}` : " · Okunmadı"}</time></article>`).join("") : '<div class="delivera-package"><p>Henüz bildirim yok.</p></div>'}</div></section>`;
    modal.querySelector(".delivera-close").onclick = () => modal.remove();
    modal.querySelector(".delivera-push-enable:not([data-read-all])")?.addEventListener("click", async () => { unlockAssignmentAudio(); const enabled = await initializeCourierPush({ requestPermission: true }); if (enabled) modal.querySelector(".delivera-push-enable:not([data-read-all])")?.remove(); });
    modal.querySelector("[data-read-all]")?.addEventListener("click", async () => {
      try {
        const result = await api("/api/courier/notifications/read", { method: "POST", body: JSON.stringify({}) });
        workspace.notifications = result.notifications || [];
        workspace.unreadNotificationCount = result.unreadNotificationCount;
        hydrate();
        showNotificationCenter();
      } catch (error) { toast(error.message || "Bildirimler okundu işaretlenemedi.", "error"); }
    });
    modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
    document.body.append(modal);
  }

  function showLogin() {
    if (document.querySelector(".delivera-login")) {
      revealCourierApp();
      return;
    }
    window.RestomapLoginShell.show({
      title: "Kurye Girişi",
      description: "Vardiyana başlamak için giriş yap.",
      fields: `<label class="delivera-auth-field full"><span>Kullanıcı adı</span><input name="username" autocomplete="username" required></label><label class="delivera-auth-field full"><span>Şifre</span><input name="password" type="password" autocomplete="current-password" required></label>`,
      onSubmit: async (form) => {
        const permissionRequest = requestCourierNotificationPermission();
        const result = await api("/api/courier/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
        saveAuth(result);
        window.RestomapLoginShell.hide();
        await loadWorkspace();
        await permissionRequest;
        await initializeCourierPush();
      },
    });
    revealCourierApp();
  }

  async function logout(callApi = true) {
    if (callApi) {
      try { const { removePush } = await import("/push-client.js"); await removePush("courier", api); } catch {}
    }
    pushInitialized = false;
    const refreshToken = localStorage.getItem(REFRESH_KEY) || "";
    if (callApi && refreshToken) api("/api/courier/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    workspace = null;
      window.clearInterval(pollId);
    eventStream?.close();
    eventStream = null;
    showLogin();
  }

  function connectEventStream() {
    if (eventStream || !token() || typeof EventSource === "undefined") return;
    eventStream = new EventSource(`/api/courier/stream?token=${encodeURIComponent(token())}`);
    const handleEvent = (event) => {
      let payload = {};
      try { payload = event.data ? JSON.parse(event.data) : {}; } catch {}
      if (payload.type === "package-assigned") {
        toast(payload.message || "Yeni paket düştü.", "success");
      }
      if (route === "/courier.html") scheduleCourierMapRefresh();
      if (payload.type !== "courier-location" && payload.type !== "ping") loadWorkspace();
    };
    eventStream.onmessage = handleEvent;
    ["package-created", "package-assigned", "package-reassign", "package-override", "package-unassign", "assignment-waiting", "package-status", "package-location-resolved", "package-location-warning", "restaurant-confirmed", "courier-availability", "shift-plan-offer", "shift-plan-accepted", "workspace-update", "courier-day-close"].forEach((type) => eventStream.addEventListener(type, handleEvent));
    eventStream.onerror = () => {
      eventStream?.close();
      eventStream = null;
      window.setTimeout(() => { if (token()) connectEventStream(); }, 4000);
    };
  }

  function bindNavigation() {
    const destinations = {
      Packages: "/courier.html", Paketler: "/courier.html",
      Earnings: "/courier-reports.html?view=earnings", "Kazançlar": "/courier-reports.html?view=earnings",
      Reports: "/courier-reports.html", Raporlar: "/courier-reports.html",
      Settings: "/courier-profile.html", Ayarlar: "/courier-profile.html",
      "Active Shift": "/courier-shift.html", "Aktif Vardiya": "/courier-shift.html",
      "Earnings History": "/courier-reports.html", "Kazanç Geçmişi": "/courier-reports.html",
      "Vehicle Status": "/courier.html", "Araç Durumu": "/courier.html"
    };
    Object.entries(destinations).forEach(([label, target]) => {
      textNodes(label).forEach((labelNode) => {
        const control = labelNode.closest("a,button");
        if (!control || control.dataset.deliveraNav) return;
        control.dataset.deliveraNav = "1";
        control.addEventListener("click", (event) => { event.preventDefault(); location.href = target; });
      });
    });
    textNodes("schedule").forEach((icon) => {
      const button = icon.closest("button");
      if (button) button.addEventListener("click", () => { location.href = "/courier-shift.html"; });
    });
    textNodes("person").forEach((icon) => {
      const button = icon.closest("button");
      if (button && route === "/courier.html") button.addEventListener("click", () => { location.href = "/courier-profile.html"; });
    });
    textNodes("arrow_back").concat(textNodes("close")).forEach((icon) => {
      const button = icon.closest("button");
      if (button) button.addEventListener("click", () => { location.href = "/courier.html"; });
    });
    ["Emergency Contacts", "Acil Durum İletişimleri", "Support", "Destek"].forEach((label) => {
      textNodes(label).forEach((node) => {
        const control = node.closest("a,button");
        if (control) control.addEventListener("click", (event) => { event.preventDefault(); callManager(); });
      });
    });
    ["Günlük", "Haftalık", "Aylık"].forEach((label) => {
      textNodes(label).forEach((node) => {
        const button = node.closest("button");
        if (!button) return;
        button.addEventListener("click", () => {
          button.parentElement.querySelectorAll("button").forEach((item) => {
            item.classList.remove("bg-primary", "text-on-primary", "shadow-sm");
            item.classList.add("text-on-surface-variant");
          });
          button.classList.add("bg-primary", "text-on-primary", "shadow-sm");
          button.classList.remove("text-on-surface-variant");
          toast(`${label} görünümü seçildi.`);
        });
      });
    });
  }

  function callManagerLegacy() {
    const phone = workspace?.courier?.managerPhone || workspace?.managerPhone || "";
    if (phone) location.href = `tel:${phone}`;
    else toast("Yönetici iletişim numarası sisteme tanımlanmamış.", "error");
  }

  function callManager() {
    const phone = workspace?.courier?.managerPhone || workspace?.managerPhone || "05314668927";
    location.href = `tel:${String(phone).replace(/[^\d+]/g, "")}`;
  }

  function replaceExact(oldText, newText, limit = Infinity) {
    let changed = 0;
    textNodes(oldText).forEach((node) => { if (changed < limit) { node.textContent = newText; changed += 1; } });
  }

  function statusLabel(status) {
    return ({ assigned: "Atandı", accepted_by_courier: "Kabul edildi", picked_up: "Yolda", on_route: "Yolda", delivered: "Teslim edildi", failed: "Sorunlu", cancelled: "İptal" })[status] || status || "Bekliyor";
  }

  function activePackages() { return (workspace?.packages || []).filter((item) => !CLOSED.has(item.status)); }

  function packageSheet() {
    document.querySelector(".delivera-modal")?.remove();
    const packages = activePackages();
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>Aktif Paketler</h2><button class="delivera-close">×</button></div><div class="delivera-package-list"></div></section>`;
    const list = modal.querySelector(".delivera-package-list");
    if (!packages.length) list.innerHTML = `<div class="delivera-package"><p>Aktif sipariş yok.</p></div>`;
    packages.forEach((pkg) => {
      const card = document.createElement("article");
      card.className = "delivera-package";
      card.innerHTML = `<header><div><small>${esc(pkg.trackingNo || "Paket")}</small><h3>${esc(pkg.recipient || pkg.customerName || "Müşteri")}</h3></div><span class="delivera-badge">${esc(statusLabel(pkg.status))}</span></header><p><b>${esc(pkg.restaurantName || "Restoran")}</b><br>${esc(pkg.deliveryAddress || pkg.address || "Adres bekleniyor")}</p><p>${money(pkg.orderAmount)} · ${esc(pkg.paymentStatus || pkg.paymentMethod || "Ödeme bilgisi yok")}</p><select><option value="">Durum seç</option><option value="accepted_by_courier">Paketi kabul et</option><option value="on_route">Yola çıktım</option><option value="delivered">Teslim edildi</option><option value="failed">Teslim edilemedi</option></select><button class="delivera-action">Durumu Güncelle</button>`;
      card.querySelector("button").addEventListener("click", async () => {
        const status = card.querySelector("select").value;
        if (!status) return toast("Önce durum seç.", "error");
        try {
          workspace = await api(`/api/courier/packages/${encodeURIComponent(pkg.id)}/status`, { method: "PATCH", body: JSON.stringify({ status, failureReason: status === "failed" ? "diger" : "" }) });
          toast("Paket durumu güncellendi.");
          modal.remove();
          hydrate();
        } catch (error) { toast(error.message, "error"); }
      });
      list.append(card);
    });
    modal.querySelector(".delivera-close").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
    document.body.append(modal);
  }

  function courierPaymentMethod(pkg) {
    const raw = String(pkg?.paymentMethodCode || pkg?.paymentMethod || "").toLowerCase();
    if (raw.includes("cash") || raw.includes("nakit")) return "cash_on_delivery";
    if (raw.includes("card") || raw.includes("kart") || raw.includes("kredi") || raw.includes("pos")) return "card_on_delivery";
    if (raw.includes("restaurant") || raw.includes("restoran")) return "restaurant_collected";
    if (raw.includes("online") || raw.includes("paid")) return "paid_online";
    return raw;
  }

  function packagePaymentOptions(pkg) {
    const method = courierPaymentMethod(pkg);
    if (method === "cash_on_delivery") return '<option value="cash_collected">Nakit tahsil edildi</option><option value="payment_issue">Nakit tahsil edilemedi</option>';
    if (method === "card_on_delivery") return '<option value="credit_card_collected">Kartla tahsil edildi</option><option value="payment_issue">Kart tahsilatı yapılamadı</option>';
    if (method === "restaurant_collected") return '<option value="restaurant_collected">Restoran tahsil etti</option><option value="payment_issue">Tahsilat sorunu var</option>';
    return "";
  }

  function packageSheet(mode = "active") {
    document.querySelector(".delivera-modal")?.remove();
    const allPackages = activePackages();
    const poolPackages = Array.isArray(workspace?.poolPackages) ? workspace.poolPackages : [];
    const historyPackages = [...(workspace?.historyPackages || [])].sort((a, b) => packageEventDate(b) - packageEventDate(a));
    const packages = mode === "pool" ? poolPackages : mode === "history" ? historyPackages : mode === "road"
      ? allPackages.filter((pkg) => ["accepted_by_courier", "on_route", "picked_up"].includes(pkg.status))
      : mode === "offers"
        ? allPackages.filter((pkg) => pkg.status === "assigned")
      : mode === "external"
        ? allPackages.filter((pkg) => !["trendyol", "getir", "yemeksepeti", "migros"].some((source) => String(pkg.sourcePlatform || pkg.platform || pkg.source || "").toLowerCase().includes(source)))
        : allPackages;
    const title = mode === "pool" ? "Atanmamış Paket Havuzu" : mode === "history" ? "Geçmiş Siparişler" : mode === "road" ? "Yoldaki Paketler" : mode === "offers" ? "Paket Teklifleri" : mode === "external" ? "Sistem Dışı Paketler" : "Aktif Paketler";
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>${title}</h2><button class="delivera-close" type="button">×</button></div><div class="delivera-package-list"></div></section>`;
    const list = modal.querySelector(".delivera-package-list");
    const poolAvailableSlots = Math.max(0, Number(workspace?.poolAvailableSlots || 0));
    if (mode === "pool") {
      const capacity = Number(workspace?.poolCapacity || 2);
      const activeLoad = Number(workspace?.courier?.activeLoad || 0);
      list.innerHTML = `<div class="delivera-package"><p><b>Aktif paket:</b> ${activeLoad}/${capacity}<br>${poolAvailableSlots > 0 ? `Havuzdan ${poolAvailableSlots} paket daha alabilirsiniz.` : "Yeni paket almak için aktif paketlerden birini tamamlayın."}</p></div>`;
    }
    if (!packages.length) list.insertAdjacentHTML("beforeend", `<div class="delivera-package"><p>${mode === "history" ? "Henüz tamamlanmış geçmiş sipariş bulunmuyor." : mode === "pool" ? "Şu anda aktif ve atanmamış paket bulunmuyor." : "Bu bölümde paket bulunmuyor."}</p></div>`);
    packages.forEach((pkg) => {
      const card = document.createElement("article");
      card.className = "delivera-package";
      if (mode === "history") {
        const finishedAt = packageEventDate(pkg);
        const products = globalThis.renderOrderItemsBox?.(pkg, { compact: true }) || "";
        card.innerHTML = `<header><div><small>${esc(pkg.trackingNo || pkg.externalOrderNo || "Paket")}</small><h3>${esc(pkg.restaurantName || "Restoran")}</h3></div><span class="delivera-badge">${esc(statusLabel(pkg.status))}</span></header><div class="delivera-history-date"><span class="material-symbols-outlined notranslate" translate="no">schedule</span>${Number.isNaN(finishedAt.getTime()) ? "Tarih bilgisi yok" : finishedAt.toLocaleString("tr-TR")}</div><div class="delivera-package-address"><b>Teslimat adresi</b><br>${esc(pkg.customerAddress || pkg.deliveryAddress || pkg.address || "Adres bilgisi yok")}</div><div class="delivera-history-details"><div><span>Müşteri</span><strong>${esc(pkg.recipient || pkg.customerName || "-")}</strong></div><div><span>Sipariş tutarı</span><strong>${money(pkg.orderAmount)}</strong></div><div><span>Ödeme</span><strong>${esc(pkg.paymentMethod || pkg.paymentStatus || "-")}</strong></div><div><span>Son durum</span><strong>${esc(statusLabel(pkg.status))}</strong></div></div>${pkg.failureReason ? `<p><b>Sorun:</b> ${esc(pkg.failureReason)}</p>` : ""}${products}`;
        list.append(card);
        return;
      }
      const paymentOptions = packagePaymentOptions(pkg);
      const failureOptions = `<option value="">Sorun nedeni seç</option><option value="musteri_yok">Müşteri adreste yok</option><option value="adres_bulunamadi">Adres bulunamadı</option><option value="restoran_hazir_degil">Restoran hazır değil</option><option value="teknik_sorun">Teknik sorun</option>${allPackages.length > 1 ? '<option value="ters_yon">Ters yön — yeniden ata</option>' : ""}<option value="diger">Diğer</option>`;
      const status = String(pkg.status || "");
      let controls = "";
      if (mode === "pool") controls = `<div class="delivera-package-actions"><button class="primary" data-action="claim" ${poolAvailableSlots > 0 ? "" : "disabled"}>${poolAvailableSlots > 0 ? "Havuzdan Al" : "Kapasite Dolu"}</button></div>`;
      else if (status === "assigned") controls = '<div class="delivera-package-actions"><button class="primary" data-action="accept">Paketi Kabul Et</button><button class="danger" data-action="reject">Paketi Reddet</button></div>';
      else if (status === "accepted_by_courier") controls = `<label class="delivera-package-field">Sorun Bildir<select data-failure>${failureOptions}</select></label><div class="delivera-package-actions"><button class="primary" data-action="route">Yola Çık</button><button class="danger" data-action="fail">Sorun Bildir</button></div>`;
      else if (["on_route", "picked_up"].includes(status)) controls = `${paymentOptions ? `<label class="delivera-package-field">Tahsilat Durumu<select data-payment>${paymentOptions}</select></label>` : ""}<label class="delivera-package-field">Teslimat Notu<input data-note placeholder="İsteğe bağlı not"></label><label class="delivera-package-field">Sorun Bildir<select data-failure>${failureOptions}</select></label><div class="delivera-package-actions"><button class="success" data-action="deliver">Teslim Edildi</button><button class="danger" data-action="fail">Sorun Bildir</button></div>`;
      else controls = `<div class="delivera-package-actions"><button class="primary" data-action="accept">Paketi Kabul Et</button></div>`;
      const phoneDisplay = String(pkg.phone || pkg.contactPhone || "").trim();
      const phone = phoneDisplay.replace(/[^+\d]/g, "");
      const restaurantCoords = Number.isFinite(Number(pkg.restaurantLat)) && Number.isFinite(Number(pkg.restaurantLng)) ? `${pkg.restaurantLat},${pkg.restaurantLng}` : "";
      const customerCoords = Number.isFinite(Number(pkg.customerLat)) && Number.isFinite(Number(pkg.customerLng)) ? `${pkg.customerLat},${pkg.customerLng}` : "";
      const customerDestination = customerCoords || pkg.customerAddress || pkg.deliveryAddress || pkg.address || "";
      card.innerHTML = `<header><div><small>${esc(pkg.trackingNo || "Paket")}</small><h3>${esc(pkg.recipient || pkg.customerName || "Müşteri")}</h3></div><span class="delivera-badge">${esc(statusLabel(pkg.status))}</span></header><div class="delivera-customer-phone"><span>Müşteri telefonu</span><strong>${esc(phoneDisplay || "Telefon bilgisi yok")}</strong></div><div class="delivera-package-meta"><span><b>Restoran</b><br>${esc(pkg.restaurantName || "Restoran")}</span><span><b>Ödeme</b><br>${esc(pkg.paymentMethod || "Belirtilmedi")}</span></div><div class="delivera-package-address"><b>Teslimat adresi</b><br>${esc(pkg.customerAddress || pkg.deliveryAddress || pkg.address || "Adres bekleniyor")}</div><div class="delivera-package-contact">${phone ? `<a href="tel:${esc(phone)}">Müşteriyi Ara</a>` : ""}${restaurantCoords ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(restaurantCoords)}">Restorana Git</a>` : ""}${customerDestination ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(customerDestination)}">Adrese Git</a>` : ""}</div>${controls}`;
      const perform = async (action) => {
        const button = card.querySelector(`[data-action="${action}"]`);
        if (button) button.disabled = true;
        try {
          if (action === "claim") workspace = await api(`/api/courier/pool/${encodeURIComponent(pkg.id)}/claim`, { method: "POST", body: "{}" });
          else if (action === "reject") workspace = await api(`/api/courier/packages/${encodeURIComponent(pkg.id)}/reject`, { method: "POST", body: "{}" });
          else {
            const payload = action === "accept" ? { status: "accepted_by_courier" }
              : action === "route" ? { status: "on_route" }
                : action === "deliver" ? { status: "delivered", paymentStatus: card.querySelector("[data-payment]")?.value, courierCollectionNote: card.querySelector("[data-note]")?.value || "" }
                  : { status: "failed", failureReason: card.querySelector("[data-failure]")?.value || "" };
            if (action === "fail" && !payload.failureReason) return toast("Önce sorun nedenini seç.", "error");
            workspace = await api(`/api/courier/packages/${encodeURIComponent(pkg.id)}/status`, { method: "PATCH", body: JSON.stringify(payload) });
          }
          const routedPackage = action === "route" ? (workspace?.packages || []).find((item) => item.id === pkg.id) : null;
          toast(action === "claim" ? "Paket havuzdan alındı." : action === "accept" ? "Paket kabul edildi." : action === "reject" ? "Paket yeniden atama havuzuna gönderildi." : action === "route" && routedPackage?.customerLocationQuality !== "confirmed" ? "Yaklaşık müşteri konumu gösteriliyor; konum doğru olmayabilir, müşteriyi arayarak doğrulayın." : action === "route" ? "Paket yola çıktı." : action === "deliver" ? "Paket teslim edildi." : "Sorun bildirimi kaydedildi.", action === "route" && routedPackage?.customerLocationQuality !== "confirmed" ? "error" : "success");
          modal.remove();
          hydrate();
        } catch (error) { toast(error.message, "error"); }
        finally { if (button) button.disabled = false; }
      };
      card.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => perform(button.dataset.action)));
      list.append(card);
    });
    modal.querySelector(".delivera-close").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
    document.body.append(modal);
  }

  function validMapCoordinates(latitudeValue, longitudeValue) {
    if (latitudeValue === null || latitudeValue === undefined || latitudeValue === "" || longitudeValue === null || longitudeValue === undefined || longitudeValue === "") return null;
    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);
    return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? { latitude, longitude }
      : null;
  }

  function packageMapPoints(packages = activePackages()) {
    const grouped = new Map();
    packages.forEach((pkg) => {
      const customerTarget = ["on_route", "picked_up"].includes(String(pkg.status || ""));
      const customerCoordinates = validMapCoordinates(pkg.customerLat ?? pkg.customerLatitude, pkg.customerLng ?? pkg.customerLongitude);
      const restaurantCoordinates = validMapCoordinates(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude);
      const type = customerTarget && customerCoordinates ? "customer" : "restaurant";
      const coordinates = type === "customer" ? customerCoordinates : restaurantCoordinates;
      if (!coordinates) return;
      const { latitude, longitude } = coordinates;
      const key = type === "customer"
        ? `customer:${pkg.id || `${latitude.toFixed(5)},${longitude.toFixed(5)}`}`
        : `restaurant:${pkg.restaurantId || `${latitude.toFixed(5)},${longitude.toFixed(5)}`}`;
      const current = grouped.get(key);
      if (current) current.packageCount += 1;
      else grouped.set(key, {
        latitude,
        longitude,
        type,
        name: type === "customer" ? (pkg.recipient || pkg.customerName || "Müşteri") : (pkg.restaurantName || "Restoran"),
        packageCount: 1,
      });
    });
    return [...grouped.values()];
  }

  function navigationTargetForPackages(packages = activePackages()) {
    const active = packages.filter((pkg) => !["delivered", "failed", "cancelled"].includes(String(pkg.status || "")));
    const ordered = [
      ...active.filter((pkg) => ["on_route", "picked_up"].includes(String(pkg.status || ""))),
      ...active.filter((pkg) => String(pkg.status || "") === "accepted_by_courier"),
      ...active.filter((pkg) => String(pkg.status || "") === "assigned"),
      ...active.filter((pkg) => !["on_route", "picked_up", "accepted_by_courier", "assigned"].includes(String(pkg.status || ""))),
    ];
    for (const pkg of ordered) {
      const customerTarget = ["on_route", "picked_up"].includes(String(pkg.status || ""));
      const coordinates = customerTarget
        ? validMapCoordinates(pkg.customerLat ?? pkg.customerLatitude, pkg.customerLng ?? pkg.customerLongitude)
        : validMapCoordinates(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude);
      if (!coordinates) continue;
      return {
        ...coordinates,
        type: customerTarget ? "customer" : "restaurant",
        name: customerTarget ? (pkg.recipient || pkg.customerName || "Müşteri") : (pkg.restaurantName || "Restoran"),
        packageId: pkg.id || "",
      };
    }
    return null;
  }

  function navigationRouteUrl(courierPoint, target) {
    const start = `${Number(courierPoint.longitude).toFixed(6)},${Number(courierPoint.latitude).toFixed(6)}`;
    const end = `${Number(target.longitude).toFixed(6)},${Number(target.latitude).toFixed(6)}`;
    return `https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=false`;
  }

  function externalNavigationUrl(target) {
    const destination = `${Number(target.latitude).toFixed(6)},${Number(target.longitude).toFixed(6)}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  }

  function directDistanceKm(from, to) {
    const radians = (value) => Number(value) * Math.PI / 180;
    const earthRadiusKm = 6371;
    const latDelta = radians(to.latitude - from.latitude);
    const lonDelta = radians(to.longitude - from.longitude);
    const startLat = radians(from.latitude);
    const endLat = radians(to.latitude);
    const a = Math.sin(latDelta / 2) ** 2 + Math.cos(startLat) * Math.cos(endLat) * Math.sin(lonDelta / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function liveMapBounds(latitude, longitude, restaurants = []) {
    const latitudes = [latitude, ...restaurants.map((item) => item.latitude)].filter(Number.isFinite);
    const longitudes = [longitude, ...restaurants.map((item) => item.longitude)].filter(Number.isFinite);
    const minLat = Math.min(...latitudes);
    const maxLat = Math.max(...latitudes);
    const minLon = Math.min(...longitudes);
    const maxLon = Math.max(...longitudes);
    const latPadding = Math.max(0.006, (maxLat - minLat) * 0.24);
    const lonPadding = Math.max(0.009, (maxLon - minLon) * 0.24);
    return { south: minLat - latPadding, west: minLon - lonPadding, north: maxLat + latPadding, east: maxLon + lonPadding };
  }

  function liveMapUrl(bounds) {
    const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(6)).join("%2C");
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik`;
  }

  function markerPosition(point, bounds) {
    return {
      left: ((point.longitude - bounds.west) / (bounds.east - bounds.west)) * 100,
      top: ((bounds.north - point.latitude) / (bounds.north - bounds.south)) * 100,
    };
  }

  function renderMapMarkers(canvas, courierPoint, destinations, bounds) {
    canvas.querySelectorAll(".delivera-map-marker").forEach((marker) => marker.remove());
    const courierPosition = markerPosition(courierPoint, bounds);
    const courierMarker = document.createElement("div");
    courierMarker.className = "delivera-map-marker delivera-courier-marker";
    courierMarker.title = "Canlı kurye konumu";
    courierMarker.style.left = `${courierPosition.left}%`;
    courierMarker.style.top = `${courierPosition.top}%`;
    canvas.append(courierMarker);
    destinations.forEach((destination) => {
      const position = markerPosition(destination, bounds);
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `delivera-map-marker ${destination.type === "customer" ? "delivera-customer-marker" : "delivera-restaurant-marker"}`;
      marker.style.left = `${position.left}%`;
      marker.style.top = `${position.top}%`;
      marker.title = `${destination.type === "customer" ? "Müşteri" : "Restoran"}: ${destination.name} · ${destination.packageCount} paket`;
      marker.innerHTML = `<span class="material-symbols-outlined notranslate" translate="no">${destination.type === "customer" ? "location_on" : "storefront"}</span><span class="delivera-restaurant-marker-label">${esc(destination.name)}${destination.packageCount > 1 ? ` (${destination.packageCount})` : ""}</span>`;
      marker.addEventListener("click", () => packageSheet(destination.type === "customer" ? "road" : "active"));
      canvas.append(marker);
    });
  }

  function updateLiveMap(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    const safeLat = Number.isFinite(lat) ? lat : 41.0082;
    const safeLon = Number.isFinite(lon) ? lon : 28.9784;
    const destinations = packageMapPoints();
    const bounds = liveMapBounds(safeLat, safeLon, destinations);
    const destinationKey = destinations.map((item) => `${item.type},${item.latitude.toFixed(5)},${item.longitude.toFixed(5)},${item.packageCount}`).join("|");
    const key = `${safeLat.toFixed(5)},${safeLon.toFixed(5)}|${destinationKey}`;
    const canvas = document.querySelector(".map-bg");
    if (!canvas) return;
    canvas.querySelectorAll(":scope > img, :scope > div").forEach((element) => { element.style.display = "none"; });
    let frame = canvas.querySelector(".delivera-live-map");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "delivera-live-map";
      frame.title = "Canlı kurye haritası";
      frame.loading = "eager";
      frame.referrerPolicy = "no-referrer";
      canvas.prepend(frame);
    }
    if (lastMapKey !== key) {
      lastMapKey = key;
      frame.src = liveMapUrl(bounds);
    }
    renderMapMarkers(canvas, { latitude: safeLat, longitude: safeLon }, destinations, bounds);
  }

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletLoader) return leafletLoader;
    leafletLoader = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-delivera-leaflet]')) {
        const stylesheet = document.createElement("link");
        stylesheet.rel = "stylesheet";
        stylesheet.href = "/vendor/leaflet.css";
        stylesheet.dataset.deliveraLeaflet = "true";
        document.head.append(stylesheet);
      }
      const existing = document.querySelector('script[data-delivera-leaflet]');
      if (existing) {
        existing.addEventListener("load", () => resolve(window.L), { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "/vendor/leaflet.js";
      script.dataset.deliveraLeaflet = "true";
      script.addEventListener("load", () => resolve(window.L), { once: true });
      script.addEventListener("error", () => reject(new Error("Harita motoru yüklenemedi.")), { once: true });
      document.head.append(script);
    });
    return leafletLoader;
  }

  function ensureNavigationMapControl(L) {
    if (navigationMapControlElement) return navigationMapControlElement;
    navigationMapControl = L.control({ position: "bottomleft" });
    navigationMapControl.onAdd = () => {
      const card = L.DomUtil.create("section", "delivera-navigation-card");
      card.hidden = true;
      card.setAttribute("aria-live", "polite");
      card.innerHTML = '<div><small data-navigation-type>Rota</small><strong data-navigation-name>Hedef</strong><span data-navigation-summary>Rota hazırlanıyor…</span></div><button type="button" data-navigation-open>Navigasyonu Aç</button>';
      const openButton = card.querySelector("[data-navigation-open]");
      openButton.addEventListener("click", () => {
        const href = openButton.dataset.href;
        if (href) window.open(href, "_blank", "noopener,noreferrer");
      });
      L.DomEvent.disableClickPropagation(card);
      L.DomEvent.disableScrollPropagation(card);
      navigationMapControlElement = card;
      return card;
    };
    navigationMapControl.addTo(leafletMap);
    return navigationMapControlElement;
  }

  function updateGpsStatus() {
    if (!gpsStatusControl) return;
    const age = gpsObservedAt ? Math.max(0, Math.floor((Date.now() - gpsObservedAt) / 1000)) : null;
    const stale = age === null || age > 30;
    gpsStatusControl.querySelector('span').textContent = age === null ? 'GPS konumu bekleniyor' : `Konum ${age} saniye önce alındı${stale ? ' · GPS bekleniyor' : ''}`;
    gpsStatusControl.querySelector('button').hidden = followCourier;
    gpsStatusControl.querySelector('button').style.display = followCourier ? 'none' : 'block';
    document.querySelector('.delivera-courier-dot')?.style.setProperty('background', stale ? '#78838e' : '#0878d1');
    document.querySelector('.map-bg')?.classList.toggle('restomap-gps-stale', stale);
  }

  function installGpsControl(L) {
    const control = L.control({ position: 'topright' });
    control.onAdd = () => {
      const element = L.DomUtil.create('div');
      element.style.cssText = 'margin-top:150px;max-width:210px;padding:8px;background:white;border-radius:10px;font-size:11px;box-shadow:0 2px 8px #0003';
      element.innerHTML = '<span></span><button type="button" style="display:block;padding:8px;color:#0061a4">Konumuma dön</button>';
      element.querySelector('button').onclick = () => { followCourier = true; if (courierMapMarker) leafletMap.setView(courierMapMarker.getLatLng(), leafletMap.getZoom()); updateGpsStatus(); };
      L.DomEvent.disableClickPropagation(element);
      gpsStatusControl = element;
      return element;
    };
    control.addTo(leafletMap);
    leafletMap.on('dragstart', () => { followCourier = false; updateGpsStatus(); });
    updateGpsStatus();
  }

  function distanceFromRouteMeters(point, geometry) {
    if (geometry.length < 2) return Infinity;
    const scale = Math.cos(point.latitude * Math.PI / 180);
    let minimum = Infinity;
    for (let i = 1; i < geometry.length; i++) {
      const a = geometry[i - 1], b = geometry[i];
      const ax = (a[0] - point.longitude) * 111320 * scale, ay = (a[1] - point.latitude) * 111320;
      const bx = (b[0] - point.longitude) * 111320 * scale, by = (b[1] - point.latitude) * 111320;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      minimum = Math.min(minimum, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return minimum;
  }

  function setNavigationMapControl(L, target, summary) {
    const card = ensureNavigationMapControl(L);
    if (!target) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const pkg = activePackages().find(item => item.id === target.packageId);
    card.querySelector("[data-navigation-type]").textContent = target.type === "customer" ? (pkg?.customerLocationQuality === 'confirmed' ? 'Müşteri rotası' : 'Yaklaşık müşteri noktası · doğrulayın') : "Restoran rotası";
    card.querySelector("[data-navigation-name]").textContent = target.name;
    card.querySelector("[data-navigation-summary]").textContent = summary;
    const openButton = card.querySelector("[data-navigation-open]");
    openButton.dataset.href = externalNavigationUrl(target);
    openButton.textContent = target.type === "customer" ? "Müşteriye Git" : "Restorana Git";
    openButton.setAttribute("aria-label", `${target.name} için navigasyonu aç`);
  }

  function clearNavigationRoute(L) {
    navigationRouteAbortController?.abort();
    navigationRouteAbortController = null;
    navigationRouteRequestId += 1;
    lastNavigationRouteKey = "";
    lastNavigationRouteSummary = "";
    routeGeometry = [];
    routeRetryAt = 0;
    if (navigationRouteLayer) navigationRouteLayer.remove();
    navigationRouteLayer = null;
    if (navigationMapControlElement) setNavigationMapControl(L, null, "");
  }

  async function updateNavigationRoute(L, courierPoint) {
    const target = navigationTargetForPackages();
    if (!target) {
      clearNavigationRoute(L);
      return;
    }
    const directKm = directDistanceKm(courierPoint, target);
    const key = [
      target.type,
      target.packageId,
      Number(courierPoint.latitude).toFixed(3),
      Number(courierPoint.longitude).toFixed(3),
      Number(target.latitude).toFixed(5),
      Number(target.longitude).toFixed(5),
    ].join("|");
    const now = Date.now();
    const deviated = routeGeometry.length > 1 && distanceFromRouteMeters(courierPoint, routeGeometry) > 60;
    const retryDue = routeRetryAt > 0 && now >= routeRetryAt;
    if (key === lastNavigationRouteKey && navigationRouteLayer && !retryDue && !(deviated && now - routeRequestedAt > 10000)) {
      setNavigationMapControl(L, target, lastNavigationRouteSummary || `${directKm.toFixed(1)} km · navigasyon hazır`);
      return;
    }
    lastNavigationRouteKey = key;
    routeRequestedAt = now;
    routeRetryAt = 0;
    routeGeometry = [];
    lastNavigationRouteSummary = `Rota hesaplanıyor · ${directKm.toFixed(1)} km kuş uçuşu`;
    setNavigationMapControl(L, target, lastNavigationRouteSummary);
    navigationRouteAbortController?.abort();
    navigationRouteAbortController = new AbortController();
    const requestId = ++navigationRouteRequestId;
    const controller = navigationRouteAbortController;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    if (navigationRouteLayer) navigationRouteLayer.remove();
    navigationRouteLayer = L.polyline([
      [courierPoint.latitude, courierPoint.longitude],
      [target.latitude, target.longitude],
    ], { color: "#0061a4", weight: 5, opacity: 0.58, dashArray: "8 10", lineCap: "round" }).addTo(leafletMap);
    try {
      const response = await fetch(navigationRouteUrl(courierPoint, target), {
        headers: { Accept: "application/json" },
        signal: navigationRouteAbortController.signal,
      });
      if (!response.ok) throw new Error(`Rota servisi HTTP ${response.status}`);
      const payload = await response.json();
      const routeResult = payload?.routes?.[0];
      const coordinates = routeResult?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error("Rota geometrisi bulunamadı.");
      if (!coordinates.every(pair => Array.isArray(pair) && validMapCoordinates(pair[1], pair[0]))) throw new Error('Geçersiz rota');
      if (requestId !== navigationRouteRequestId || key !== lastNavigationRouteKey) return;
      navigationRouteLayer.remove();
      routeGeometry = coordinates;
      navigationRouteLayer = L.polyline(coordinates.map(([longitude, latitude]) => [latitude, longitude]), {
        color: "#0061a4",
        weight: 6,
        opacity: 0.9,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(leafletMap);
      const distanceKm = Number(routeResult.distance || 0) / 1000;
      const durationMinutes = Math.max(1, Math.round(Number(routeResult.duration || 0) / 60));
      lastNavigationRouteSummary = `${distanceKm.toFixed(1)} km · yaklaşık ${durationMinutes} dk`;
      setNavigationMapControl(L, target, lastNavigationRouteSummary);
    } catch (error) {
      if (requestId !== navigationRouteRequestId) return;
      routeRetryAt = Date.now() + 15000;
      lastNavigationRouteSummary = `${directKm.toFixed(1)} km kuş uçuşu · rota tekrar denenecek`;
      setNavigationMapControl(L, target, lastNavigationRouteSummary);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function updateRealLiveMap(latitude, longitude) {
    const serverGps = new Date(workspace?.courier?.gpsObservedAt || '').getTime();
    if (lastKnownCourierCoords && gpsObservedAt > (Number.isFinite(serverGps) ? serverGps : 0)) {
      latitude = lastKnownCourierCoords.latitude;
      longitude = lastKnownCourierCoords.longitude;
    }
    if (Number.isFinite(serverGps)) gpsObservedAt = Math.max(gpsObservedAt, serverGps);
    const lat = Number(latitude);
    const lon = Number(longitude);
    const safeLat = Number.isFinite(lat) ? lat : 41.0082;
    const safeLon = Number.isFinite(lon) ? lon : 28.9784;
    const destinations = packageMapPoints();
    const destinationKey = destinations.map((item) => `${item.type},${item.latitude.toFixed(5)},${item.longitude.toFixed(5)},${item.packageCount}`).join("|");
    const canvas = document.querySelector(".map-bg");
    if (!canvas) return;
    try {
      const L = await loadLeaflet();
      if (!leafletMap) {
        canvas.replaceChildren();
        leafletMap = L.map(canvas, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([safeLat, safeLon], 15);
        installGpsControl(L);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(leafletMap);
      }
      const courierLatLng = L.latLng(safeLat, safeLon);
      if (!courierMapMarker) {
        courierMapMarker = L.marker(courierLatLng, {
          zIndexOffset: 1000,
          title: "Canlı kurye konumu",
          icon: L.divIcon({ className: "delivera-leaflet-courier-icon", html: '<span class="delivera-courier-dot"></span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).addTo(leafletMap);
      } else {
        courierMapMarker.setLatLng(courierLatLng);
      }
      if (destinationKey !== lastDestinationMapKey) {
        destinationMapMarkers.forEach((marker) => marker.remove());
        destinationMapMarkers = destinations.map((destination) => {
          const isCustomer = destination.type === "customer";
          const count = destination.packageCount > 1 ? ` (${destination.packageCount})` : "";
          const marker = L.marker([destination.latitude, destination.longitude], {
            title: `${isCustomer ? "Müşteri" : "Restoran"}: ${destination.name} · ${destination.packageCount} paket`,
            icon: L.divIcon({ className: isCustomer ? "delivera-leaflet-customer-icon" : "delivera-leaflet-restaurant-icon", html: `<span class="${isCustomer ? "delivera-customer-dot" : "delivera-restaurant-dot"}"><span class="material-symbols-outlined notranslate" translate="no">${isCustomer ? "location_on" : "storefront"}</span><span class="delivera-restaurant-marker-label">${esc(destination.name)}${count}</span></span>`, iconSize: [38, 38], iconAnchor: [19, 19] }),
          }).addTo(leafletMap);
          marker.on("click", () => packageSheet(isCustomer ? "road" : "active"));
          return marker;
        });
        lastDestinationMapKey = destinationKey;
        const points = [courierLatLng, ...destinations.map((item) => L.latLng(item.latitude, item.longitude))];
        if (points.length > 1) leafletMap.fitBounds(L.latLngBounds(points), { paddingTopLeft: [55, 150], paddingBottomRight: [150, 150], maxZoom: 16 });
        else leafletMap.setView(courierLatLng, Math.max(leafletMap.getZoom(), 15));
      }
      void updateNavigationRoute(L, { latitude: safeLat, longitude: safeLon });
      if (followCourier) leafletMap.setView(courierLatLng, leafletMap.getZoom(), { animate: false });
      updateGpsStatus();
      requestAnimationFrame(() => leafletMap?.invalidateSize(false));
    } catch (error) {
      console.error("Canlı harita başlatılamadı", error);
      toast("Canlı harita başlatılamadı.", "error");
    }
  }

  async function refreshCourierMapData() {
    if (route !== "/courier.html" || !leafletMap || courierMapRefreshBusy || !token()) return;
    courierMapRefreshBusy = true;
    try {
      const liveMap = await api("/api/courier/live-map");
      if (!workspace) workspace = {};
      if (liveMap.courier) workspace.courier = { ...(workspace.courier || {}), ...liveMap.courier };
      if (Array.isArray(liveMap.packages)) workspace.packages = liveMap.packages;
      updateRealLiveMap(workspace.courier?.latitude, workspace.courier?.longitude);
      const mapCanvas = document.querySelector(".map-bg");
      if (mapCanvas) mapCanvas.dataset.liveMapUpdatedAt = liveMap.generatedAt || new Date().toISOString();
    } catch {
      // Son başarılı harita görünümünü koru; sonraki canlı olay veya aralık tekrar dener.
    } finally {
      courierMapRefreshBusy = false;
    }
  }

  function scheduleCourierMapRefresh() {
    window.clearTimeout(courierMapRefreshTimer);
    courierMapRefreshTimer = window.setTimeout(refreshCourierMapData, 180);
  }

  function startCourierMapRefresh() {
    if (courierMapPoll !== null || route !== "/courier.html") return;
    courierMapPoll = window.setInterval(refreshCourierMapData, 5000);
    scheduleCourierMapRefresh();
  }

  function stopLiveLocation() {
    if (mapWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(mapWatchId);
    mapWatchId = null;
    if (mapHeartbeatId !== null) window.clearInterval(mapHeartbeatId);
    mapHeartbeatId = null;
  }

  async function pushLiveLocationHeartbeat() {
    if (!token() || !workspace?.courier?.available || connectionBusy || locationHeartbeatBusy) return;
    const latitude = Number(lastKnownCourierCoords?.latitude ?? workspace.courier?.latitude);
    const longitude = Number(lastKnownCourierCoords?.longitude ?? workspace.courier?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    locationHeartbeatBusy = true;
    try {
      const next = await api("/api/courier/location", {
        method: "PATCH",
        body: JSON.stringify({ latitude, longitude, available: true, locationOnly: true, observedAt: gpsObservedAt || null }),
      });
      lastLocationPushAt = Date.now();
      if (next?.courier && workspace) workspace.courier = { ...workspace.courier, ...next.courier };
    } catch {
      // Arka plan zamanlayicilari tarayici tarafindan geciktirilebilir. Sonraki
      // heartbeat veya sayfa geri donusu ayni oturumla tekrar dener.
    } finally {
      locationHeartbeatBusy = false;
    }
  }

  function startLiveLocation() {
    if (!navigator.geolocation || !workspace?.courier?.available) return;
    const initialLatitude = Number(workspace.courier?.latitude);
    const initialLongitude = Number(workspace.courier?.longitude);
    if (!lastKnownCourierCoords && Number.isFinite(initialLatitude) && Number.isFinite(initialLongitude)) {
      lastKnownCourierCoords = { latitude: initialLatitude, longitude: initialLongitude };
    }
    if (mapHeartbeatId === null) {
      mapHeartbeatId = window.setInterval(pushLiveLocationHeartbeat, 20_000);
    }
    if (mapWatchId !== null) return;
    mapWatchId = navigator.geolocation.watchPosition(async (position) => {
      const latitude = Number(position.coords.latitude.toFixed(6));
      const longitude = Number(position.coords.longitude.toFixed(6));
      lastKnownCourierCoords = { latitude, longitude };
      gpsObservedAt = Math.min(Date.now(), Number(position.timestamp) || Date.now());
      updateRealLiveMap(latitude, longitude);
      if (Date.now() - lastLocationPushAt < 10000 || connectionBusy || locationHeartbeatBusy) return;
      lastLocationPushAt = Date.now();
      locationHeartbeatBusy = true;
      try {
        const next = await api("/api/courier/location", { method: "PATCH", body: JSON.stringify({ latitude, longitude, available: true, locationOnly: true, observedAt: gpsObservedAt }) });
        if (next?.courier && workspace) workspace.courier = next.courier;
      } catch (error) { toast(error.message || "Canlı konum güncellenemedi.", "error"); }
      finally { locationHeartbeatBusy = false; }
    }, (error) => {
      stopLiveLocation();
      toast(error.code === 1 ? "Canlı harita için konum izni gerekli." : "GPS konumu alınamadı.", "error");
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 });
  }

  function bindMapSideMenu() {
    const icon = [...document.querySelectorAll(".material-symbols-outlined")].find((item) => item.textContent.trim() === "chevron_right" && item.closest(".absolute.right-4"));
    const trigger = icon?.parentElement;
    const menu = trigger?.parentElement;
    if (!trigger || !menu || trigger.dataset.deliveraBound === "true") return;
    trigger.dataset.deliveraBound = "true";
    trigger.classList.add("delivera-side-menu-trigger");
    menu.classList.add("delivera-side-menu");
    trigger.setAttribute("role", "button");
    trigger.setAttribute("tabindex", "0");
    menu.classList.add("is-collapsed");
    icon.textContent = "chevron_left";
    trigger.setAttribute("aria-label", "Hızlı işlemleri kapat");
    trigger.setAttribute("aria-label", "Hızlı işlemleri aç");
    const toggle = () => {
      const collapsed = menu.classList.toggle("is-collapsed");
      icon.textContent = collapsed ? "chevron_left" : "chevron_right";
      trigger.setAttribute("aria-label", collapsed ? "Hızlı işlemleri aç" : "Hızlı işlemleri kapat");
    };
    trigger.addEventListener("click", toggle);
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }

  async function hydrateMap() {
    const courier = workspace.courier || {};
    const packages = activePackages();
    const onRoad = packages.filter((item) => ["on_route", "picked_up"].includes(item.status));
    const mapReady = updateRealLiveMap(courier.latitude, courier.longitude);
    startCourierMapRefresh();
    if (courier.available) startLiveLocation();
    else stopLiveLocation();
    bindMapSideMenu();
    const managerCallButton = [...document.querySelectorAll(".material-symbols-outlined")].find((icon) => icon.textContent.trim() === "phone_in_talk")?.closest("button");
    if (managerCallButton) {
      managerCallButton.type = "button";
      managerCallButton.setAttribute("aria-label", "Yöneticiyi 0531 466 89 27 numarasından ara");
      managerCallButton.onclick = callManager;
    }
    await mapReady;
    replaceExact("Deneme 123", courier.name || "Kurye", 1);
    const headerName = containsText(courier.name || "Kurye")[0];
    const headerCard = headerName?.parentElement;
    const headerCount = headerCard?.querySelector(".font-label-numeric");
    if (headerCount) headerCount.textContent = packages.length;
    const profileButton = textNodes("person").map((icon) => icon.closest("button")).find(Boolean);
    if (profileButton && !document.querySelector(".delivera-notification-button")) {
      const notificationButton = document.createElement("button");
      notificationButton.type = "button";
      notificationButton.className = "delivera-notification-button";
      notificationButton.setAttribute("aria-label", "Bildirim Merkezi");
      notificationButton.innerHTML = '<span class="material-symbols-outlined notranslate" translate="no">notifications</span><span class="delivera-notification-badge"></span>';
      notificationButton.onclick = showNotificationCenter;
      profileButton.insertAdjacentElement("beforebegin", notificationButton);
    }
    const notificationBadge = document.querySelector(".delivera-notification-badge");
    if (notificationBadge) {
      const unread = workspace.unreadNotificationCount ?? (workspace.notifications || []).filter((item) => item.unread !== false && !item.readAt).length;
      notificationBadge.textContent = unread ? String(Math.min(99, unread)) : "";
    }
    textNodes("Aktif Paket").forEach((label) => { const count = label.parentElement?.querySelector("div"); if (count) count.textContent = packages.length; const button = label.closest("button"); if (button) button.onclick = () => packageSheet("active"); });
    textNodes("Yoldaki Paket").forEach((label) => { const count = label.parentElement?.querySelector("div"); if (count) count.textContent = onRoad.length; const button = label.closest("button"); if (button) button.onclick = () => packageSheet("road"); });
    document.querySelectorAll("[data-delivera-history-pill]").forEach((button) => button.remove());
    textNodes("Havuz").forEach((label) => {
      const button = label.closest("button");
      const badge = button?.querySelector(".absolute.-top-2");
      if (badge) badge.textContent = String((workspace.poolPackages || []).length);
      if (button) button.onclick = () => packageSheet("pool");
    });
    textNodes("Sistem Dışı").forEach((label) => { const button = label.closest("button"); if (button) button.onclick = () => packageSheet("external"); });
    textNodes("Yönetici Ara").forEach((label) => { const button = label.closest("button"); if (button) button.onclick = callManager; });
    const empty = containsText("Aktif sipariş yok")[0]?.parentElement;
    if (empty) empty.style.display = packages.length ? "none" : "";
    const status = containsText("MÜSAİT")[0] || containsText("MÃœSAÄ°T")[0];
    if (status) {
      status.textContent = courier.available ? "MÜSAİT" : "ÇEVRİMDIŞI";
      status.parentElement.style.cursor = "pointer";
      status.parentElement.onclick = toggleAvailability;
    }
  }

  async function toggleAvailability(forceAvailable) {
    try {
      let coords = { latitude: workspace.courier?.latitude, longitude: workspace.courier?.longitude };
      const available = typeof forceAvailable === "boolean" ? forceAvailable : !workspace.courier?.available;
      if (available && navigator.geolocation) {
        const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000 }));
        coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      }
      workspace = await api("/api/courier/location", { method: "PATCH", body: JSON.stringify({ ...coords, available }) });
      if (available) {
        lastKnownCourierCoords = { latitude: Number(coords.latitude), longitude: Number(coords.longitude) };
        updateRealLiveMap(coords.latitude, coords.longitude);
        startLiveLocation();
      } else {
        stopLiveLocation();
      }
      hydrate();
      toast(available ? "Vardiya ve konum açıldı." : "Vardiya kapatıldı.");
    } catch (error) { toast(error.message || "Konum alınamadı.", "error"); }
  }

  function updateLabelValue(label, value) {
    textNodes(label).forEach((labelNode) => {
      let box = labelNode.parentElement;
      for (let depth = 0; box && depth < 5; depth += 1, box = box.parentElement) {
        const valueNode = [...box.querySelectorAll(".font-label-numeric,.font-display-lg")]
          .find((node) => node !== labelNode && !node.contains(labelNode));
        if (!valueNode) continue;
        valueNode.textContent = value;
        break;
      }
    });
  }

  function updateLabelCaption(label, value) {
    textNodes(label).forEach((labelNode) => {
      let box = labelNode.parentElement;
      for (let depth = 0; box && depth < 5; depth += 1, box = box.parentElement) {
        const caption = box.querySelector(".font-caption");
        if (!caption) continue;
        caption.textContent = value;
        break;
      }
    });
  }

  function reportPackages() {
    const seen = new Set();
    return [...(workspace?.packages || []), ...(workspace?.historyPackages || [])].filter((pkg) => {
      if (!pkg?.id || seen.has(pkg.id)) return false;
      seen.add(pkg.id);
      return true;
    });
  }

  function reportDetailRow(label, value) {
    return `<div class="delivera-detail-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function reportDetailMetric(label, value) {
    return `<div class="delivera-detail-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function paymentKind(pkg) {
    const raw = String(pkg?.paymentMethod || pkg?.paymentType || pkg?.paymentStatus || "").toUpperCase();
    if (raw.includes("CASH") || raw.includes("NAKIT")) return "Nakit";
    if (raw.includes("CARD") || raw.includes("KART")) return "Kredi Kartı";
    if (raw.includes("ONLINE") || raw.includes("PAID")) return "Online Ödeme";
    return "Ödeme bilgisi yok";
  }

  function renderReportDetail() {
    if (reportView === "overview") return;
    const content = document.querySelector("main > div.flex-1") || document.querySelector("main > div");
    if (!content) return;
    content.querySelector("[data-delivera-report-detail]")?.remove();
    const sections = [...content.children].filter((element) => element.tagName === "SECTION");
    sections.forEach((section, index) => { if (index >= 3) section.style.display = "none"; });

    const metrics = workspace.dayMetrics || {};
    const earnings = workspace.earningsSummary || {};
    const packages = reportPackages();
    const managementRecords = workspace.managementRecords || [];
    const cashCollected = Number(metrics.cashCollectedAmount ?? earnings.today?.cashAmount ?? 0);
    const cardCollected = Number(metrics.creditCardAmount || 0);
    const restaurantDelivered = Number(metrics.restaurantCollectedAmount || 0);
    const onlinePaid = Number(metrics.paidOnlineAmount ?? earnings.today?.paidOnlineAmount ?? 0);
    const failedCollection = Number(metrics.failedCollectionTotal || 0);
    const cashOnCourier = Math.max(0, cashCollected - restaurantDelivered);
    const titles = {
      cash: ["payments", "Üzerimdeki Nakit"],
      "payment-changes": ["sync_alt", "Ödeme Değişikliklerim"],
      restaurants: ["storefront", "İşletme Bazlı Teslimatlar"],
      settlements: ["account_balance", "Teslim Ettiğim Bakiye"],
      earnings: ["account_balance_wallet", "Kazançlarım"]
    };
    const [icon, title] = titles[reportView] || titles.cash;
    const detail = document.createElement("section");
    detail.dataset.deliveraReportDetail = "1";
    detail.className = "delivera-report-detail";
    let body = "";

    if (reportView === "cash") {
      const cashPackages = packages.filter((pkg) => paymentKind(pkg) === "Nakit").slice(0, 20);
      body = `<div class="delivera-detail-card"><h3>Güncel Nakit Durumu</h3><div class="delivera-detail-grid">${reportDetailMetric("Kurye üzerindeki nakit", money(cashOnCourier))}${reportDetailMetric("Toplam nakit tahsilatı", money(cashCollected))}${reportDetailMetric("Restorana teslim edilen", money(restaurantDelivered))}${reportDetailMetric("Başarısız tahsilat", money(failedCollection))}</div></div><div class="delivera-detail-card"><h3>Nakit Paketler</h3><div class="delivera-detail-list">${cashPackages.length ? cashPackages.map((pkg) => reportDetailRow(`${pkg.trackingNo || "Paket"} · ${pkg.restaurantName || "Restoran"}`, `${money(pkg.orderAmount)} · ${statusLabel(pkg.status)}`)).join("") : '<p class="delivera-detail-empty">Nakit paket kaydı bulunmuyor.</p>'}</div></div>`;
    } else if (reportView === "payment-changes") {
      const paymentPackages = packages.slice(0, 25);
      const paymentChanges = managementRecords.filter((record) => record.recordType === "payment_change");
      body = `<div class="delivera-detail-card"><h3>Admin Ödeme Değişiklikleri</h3><div class="delivera-detail-list">${paymentChanges.length ? paymentChanges.map((record) => reportDetailRow(`${record.startDate || "Tarihsiz"} · ${record.title}`, `${record.amount ? money(record.amount) : "Tutar yok"} · ${record.status === "completed" ? "Tamamlandı" : "Aktif"}${record.note ? ` · ${record.note}` : ""}`)).join("") : '<p class="delivera-detail-empty">Admin tarafından tanımlanmış ödeme değişikliği bulunmuyor.</p>'}</div></div><div class="delivera-detail-card"><h3>Ödeme Kırılımı</h3><div class="delivera-detail-grid">${reportDetailMetric("Online ödeme", money(onlinePaid))}${reportDetailMetric("Nakit", money(cashCollected))}${reportDetailMetric("Kredi kartı", money(cardCollected))}${reportDetailMetric("Başarısız tahsilat", money(failedCollection))}</div></div><div class="delivera-detail-card"><h3>Paket Ödeme Durumları</h3><div class="delivera-detail-list">${paymentPackages.length ? paymentPackages.map((pkg) => reportDetailRow(`${pkg.trackingNo || "Paket"} · ${paymentKind(pkg)}`, `${money(pkg.orderAmount)} · ${statusLabel(pkg.status)}`)).join("") : '<p class="delivera-detail-empty">Ödeme hareketi bulunmuyor.</p>'}</div></div>`;
    } else if (reportView === "restaurants") {
      const grouped = new Map();
      packages.forEach((pkg) => {
        const key = pkg.restaurantName || "Restoran belirtilmemiş";
        const current = grouped.get(key) || { count: 0, amount: 0 };
        current.count += 1;
        current.amount += Number(pkg.orderAmount || 0);
        grouped.set(key, current);
      });
      body = `<div class="delivera-detail-card"><h3>İşletme Özeti</h3><div class="delivera-detail-grid">${reportDetailMetric("İşletme sayısı", grouped.size)}${reportDetailMetric("Toplam paket", packages.length)}${reportDetailMetric("Toplam sipariş tutarı", money(packages.reduce((sum, pkg) => sum + Number(pkg.orderAmount || 0), 0)))}${reportDetailMetric("Restorana teslim edilen", money(restaurantDelivered))}</div></div><div class="delivera-detail-card"><h3>İşletme Bazlı Paketler</h3><div class="delivera-detail-list">${grouped.size ? [...grouped.entries()].map(([name, item]) => reportDetailRow(name, `${item.count} paket · ${money(item.amount)}`)).join("") : '<p class="delivera-detail-empty">İşletme bazlı teslimat bulunmuyor.</p>'}</div></div>`;
    } else if (reportView === "settlements") {
      body = `<div class="delivera-detail-card"><h3>Bakiye Teslim Durumu</h3><div class="delivera-detail-grid">${reportDetailMetric("Teslim edilen bakiye", money(restaurantDelivered))}${reportDetailMetric("Kurye üzerinde kalan", money(cashOnCourier))}${reportDetailMetric("Toplam nakit tahsilatı", money(cashCollected))}${reportDetailMetric("Gün sonu durumu", metrics.hasClosedDay ? "Tamamlandı" : "Bekliyor")}</div></div><div class="delivera-detail-card"><h3>Hesap Özeti</h3><div class="delivera-detail-list">${reportDetailRow("Nakit tahsilat", money(cashCollected))}${reportDetailRow("Restorana teslim", money(restaurantDelivered))}${reportDetailRow("Kalan teslim edilecek", money(cashOnCourier))}${reportDetailRow("Kurye kazancı", money(metrics.courierEarnings || earnings.today?.courierEarnings || 0))}</div></div>`;
    } else {
      const adjustments = managementRecords.filter((record) => record.recordType === "courier_adjustment");
      body = `<div class="delivera-detail-card"><h3>Kazanç Özeti</h3><div class="delivera-detail-grid">${reportDetailMetric("Bugün", money(earnings.today?.courierEarnings || metrics.courierEarnings || 0))}${reportDetailMetric("Dün", money(earnings.yesterday?.courierEarnings || 0))}${reportDetailMetric("Son 7 gün", money(earnings.last7Days?.courierEarnings || 0))}${reportDetailMetric("Toplam", money(earnings.total?.courierEarnings || 0))}</div></div><div class="delivera-detail-card"><h3>Ödül ve Kesintiler</h3><div class="delivera-detail-list">${adjustments.length ? adjustments.map((record) => reportDetailRow(`${record.startDate || "Tarihsiz"} · ${record.title}`, `${record.amount >= 0 ? "+" : ""}${money(record.amount)} · ${record.status === "completed" ? "Tamamlandı" : "Aktif"}`)).join("") : '<p class="delivera-detail-empty">Ödül veya kesinti kaydı bulunmuyor.</p>'}</div></div>`;
    }

    detail.innerHTML = `<h2 class="delivera-detail-title"><span class="material-symbols-outlined notranslate" translate="no">${icon}</span>${esc(title)}</h2>${body}<button class="delivera-report-back" type="button">Genel Raporlara Dön</button>`;
    detail.querySelector(".delivera-report-back").addEventListener("click", () => { location.href = "/courier-reports.html"; });
    const statsSection = sections[1] || sections[0];
    if (statsSection) statsSection.insertAdjacentElement("afterend", detail);
    else content.prepend(detail);
    const header = document.querySelector("header h1");
    if (header) header.textContent = title;
    content.scrollTop = 0;
  }

  function packageEventDate(pkg) {
    return new Date(pkg.deliveredAt || pkg.failedAt || pkg.updatedAt || pkg.createdAt || 0);
  }

  function renderReportChart() {
    const chart = [...document.querySelectorAll(".relative.h-40")].find((item) => item.querySelector(".absolute.inset-0"));
    if (!chart) return;
    chart.querySelector(".delivera-chart-bars")?.remove();
    const today = new Date();
    const values = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      return reportPackages().filter((pkg) => pkg.status === "delivered" && packageEventDate(pkg) >= date && packageEventDate(pkg) < next).length;
    });
    const max = Math.max(1, ...values);
    const bars = document.createElement("div");
    bars.className = "delivera-chart-bars";
    bars.innerHTML = values.map((value) => `<div class="delivera-chart-bar" title="${value}" style="height:${Math.max(3, (value / max) * 100)}%"></div>`).join("");
    chart.append(bars);
    const yLabels = chart.querySelectorAll(".text-outline.pb-6 span");
    if (yLabels.length >= 3) { yLabels[0].textContent = max; yLabels[1].textContent = Math.ceil(max / 2); yLabels[2].textContent = "0"; }
  }

  function renderReportPeriod(period = reportPeriod) {
    reportPeriod = period;
    const serverSummary = workspace?.reportSummary?.[period];
    const now = new Date();
    const start = period === "daily" ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : period === "weekly" ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    const delivered = reportPackages().filter((pkg) => pkg.status === "delivered" && packageEventDate(pkg) >= start);
    const durations = delivered.map((pkg) => {
      const created = new Date(pkg.createdAt || 0).getTime();
      const ended = packageEventDate(pkg).getTime();
      return created > 0 && ended >= created ? (ended - created) / 60000 : 0;
    }).filter((value) => value > 0);
    const fallbackAverage = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0;
    const deliveredCount = Number(serverSummary?.deliveredCount ?? delivered.length);
    const average = Math.round(Number(serverSummary?.averageDeliveryMinutes ?? fallbackAverage));
    updateLabelValue("Teslimat", deliveredCount);
    updateLabelValue("Ort. Süre", `${average} dk`);
    const periodCaption = { daily: "Bugün", weekly: "Son 7 Gün", monthly: "Son 30 Gün" }[period] || "Bugün";
    updateLabelCaption("Teslimat", periodCaption);
    updateLabelCaption("Ort. Süre", periodCaption);
    const labels = { daily: "Günlük", weekly: "Haftalık", monthly: "Aylık" };
    Object.entries(labels).forEach(([key, text]) => textNodes(text).forEach((node) => {
      const button = node.closest("button");
      if (!button) return;
      button.classList.toggle("bg-primary", key === period);
      button.classList.toggle("text-on-primary", key === period);
      button.classList.toggle("shadow-sm", key === period);
      button.classList.toggle("text-on-surface-variant", key !== period);
      button.onclick = () => renderReportPeriod(key);
    }));
    renderReportChart();
  }

  function hydrateReports() {
    const courier = workspace.courier || {};
    const metrics = workspace.dayMetrics || {};
    const earnings = workspace.earningsSummary || {};
    replaceExact("Deneme 123", courier.name || "Kurye");
    updateLabelValue("Paket", metrics.deliveredCount || 0);
    updateLabelValue("Kazanç", money(earnings.today?.courierEarnings || metrics.courierEarnings || 0));
    updateLabelValue("Ekstra KM", "0.00");
    updateLabelValue("Teslimat", metrics.deliveredCount || 0);
    updateLabelValue("Ort. Süre", "0 dk");
    updateLabelValue("Ort. SÃ¼re", "0 dk");
    const dailyReport = workspace.reportSummary?.daily || { deliveredCount: metrics.deliveredCount || 0, averageDeliveryMinutes: 0 };
    const weeklyReport = workspace.reportSummary?.weekly || { deliveredCount: earnings.last7Days?.deliveredCount || 0, averageDeliveryMinutes: 0 };
    containsText("Ortalama Teslimat Süresi").concat(containsText("Ortalama Teslimat SÃ¼resi")).forEach((label) => { const value = label.closest("div.flex")?.parentElement?.querySelector(".font-label-numeric"); if (value) value.textContent = `${Math.round(Number(dailyReport.averageDeliveryMinutes || 0))} dakika`; });
    containsText("Bugünkü Teslimatlar").concat(containsText("BugÃ¼nkÃ¼ Teslimatlar")).forEach((label) => { const value = label.closest("div.flex")?.parentElement?.querySelector(".font-label-numeric"); if (value) value.textContent = `${metrics.deliveredCount || 0} sipariş`; });
    containsText("Haftalık Teslimatlar").concat(containsText("HaftalÄ±k Teslimatlar")).forEach((label) => { const value = label.closest("div.flex")?.parentElement?.querySelector(".font-label-numeric"); if (value) value.textContent = `${weeklyReport.deliveredCount || 0} sipariş`; });
    textNodes("edit").forEach((icon) => { const button = icon.closest("button"); if (button) button.onclick = profileSheet; });
    renderReportPeriod(reportPeriod);
    renderReportDetail();
  }

  function showShiftPlans() {
    document.querySelector(".delivera-modal")?.remove();
    const plans = workspace?.shiftSummary?.shiftPlans || [];
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>Haftalık Vardiyam</h2><button class="delivera-close" type="button">×</button></div><div class="delivera-package-list"></div></section>`;
    const list = modal.querySelector(".delivera-package-list");
    if (!plans.length) list.innerHTML = '<div class="delivera-package"><p>Tanımlanmış vardiya planı bulunmuyor.</p></div>';
    plans.forEach((plan) => {
      const item = document.createElement("article");
      item.className = "delivera-package";
      const status = ({ pending: "Onay bekliyor", accepted: "Kabul edildi", expired: "Süresi doldu", cancelled: "İptal edildi" })[plan.status] || plan.status;
      item.innerHTML = `<header><div><small>${esc(plan.planDate || "Tarih")}</small><h3>${esc(plan.startTime || "--:--")} – ${esc(plan.endTime || "--:--")}</h3></div><span class="delivera-badge">${esc(status)}</span></header><p><b>Bölge:</b> ${esc(plan.zone || workspace.courier?.zone || "Belirtilmedi")}</p>${plan.status === "pending" ? '<button class="delivera-action" type="button">Vardiyayı Kabul Et</button>' : ""}`;
      item.querySelector("button")?.addEventListener("click", async (event) => {
        event.currentTarget.disabled = true;
        try {
          workspace = await api(`/api/courier/shift-plans/${encodeURIComponent(plan.id)}/accept`, { method: "POST", body: "{}" });
          modal.remove();
          toast("Vardiya planı kabul edildi.");
          showShiftPlans();
        } catch (error) { toast(error.message, "error"); event.currentTarget.disabled = false; }
      });
      list.append(item);
    });
    modal.querySelector(".delivera-close").onclick = () => modal.remove();
    modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
    document.body.append(modal);
  }

  function showLeaveDays() {
    document.querySelector(".delivera-modal")?.remove();
    const plans = workspace?.shiftSummary?.shiftPlans || [];
    const plannedDates = new Set(plans.filter((plan) => ["pending", "accepted"].includes(plan.status)).map((plan) => plan.planDate));
    const leaveRecords = (workspace?.managementRecords || []).filter((record) => record.recordType === "courier_leave" && record.status !== "completed");
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const leave = leaveRecords.find((record) => (!record.startDate || record.startDate <= key) && (!record.endDate || record.endDate >= key));
      return { key, label: new Intl.DateTimeFormat("tr-TR", { weekday: "long", day: "numeric", month: "long" }).format(date), planned: plannedDates.has(key), leave };
    });
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>İzin Günüm</h2><button class="delivera-close" type="button">×</button></div><div class="delivera-detail-list">${days.map((day) => reportDetailRow(day.label, day.leave ? `İzinli · ${day.leave.title}${day.leave.note ? ` · ${day.leave.note}` : ""}` : day.planned ? "Vardiya planlı" : "Vardiya planı yok")).join("")}</div></section>`;
    modal.querySelector(".delivera-close").onclick = () => modal.remove();
    modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
    document.body.append(modal);
  }

  function showDayClose() {
    document.querySelector(".delivera-modal")?.remove();
    const metrics = workspace?.dayMetrics || {};
    const activePackages = (workspace?.packages || []).filter((pkg) => ["assigned", "accepted_by_courier", "on_route"].includes(pkg.status));
    const alreadyClosed = Boolean(metrics.hasClosedDay);
    const displayMetrics = alreadyClosed && metrics.closedSummary ? metrics.closedSummary : metrics;
    const history = workspace?.courierDailyReports || [];
    const historyHtml = history.length ? `<div class="delivera-detail-card" style="margin-top:12px"><h3>Geçmiş Gün Sonları</h3><div class="delivera-detail-list">${history.map((report) => reportDetailRow(report.reportDate, `${Number(report.deliveredCount || 0)} paket · ${money(report.totalAmount || 0)} · ${report.status === "approved" ? "Onaylandı" : report.status === "rejected" ? "Reddedildi" : "Onay bekliyor"}`)).join("")}</div></div>` : "";
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>${alreadyClosed ? "Gün Sonu Özeti" : "Gün Sonu Al"}</h2><button class="delivera-close" type="button">×</button></div><p>Bugünün paket ve tahsilat özeti admin panelindeki <b>Kurye Tahsilat</b> ekranına gönderilecek.</p><div class="delivera-day-close-summary"><div><span>Teslim edilen paket</span><strong>${Number(displayMetrics.deliveredCount || 0)}</strong></div><div><span>Toplam sipariş</span><strong>${money(displayMetrics.totalAmount || 0)}</strong></div><div><span>Nakit tahsilat</span><strong>${money(displayMetrics.cashCollectedAmount || 0)}</strong></div><div><span>Başarısız tahsilat</span><strong>${money(displayMetrics.failedCollectionTotal || 0)}</strong></div></div>${alreadyClosed ? '<div class="delivera-day-close-warning">Bugünün gün sonu daha önce alındı ve admin tahsilatına gönderildi. Güncel sayaçlar yeni gün için sıfırlandı.</div>' : activePackages.length ? `<div class="delivera-day-close-warning">Üzerinizde ${activePackages.length} aktif paket var. Gün sonu için önce paketleri tamamlayın.</div>` : '<label class="delivera-package-field">Kurye notu<textarea class="delivera-day-close-note" placeholder="Varsa gün sonu notunuzu yazın"></textarea></label>'}${historyHtml}<div class="delivera-day-close-actions"><button class="delivera-day-close-cancel" type="button">Kapat</button><button class="delivera-day-close-submit" type="button" ${alreadyClosed || activePackages.length ? "disabled" : ""}>${alreadyClosed ? "Gönderildi" : "Gün Sonunu Gönder"}</button></div></section>`;
    const close = () => modal.remove();
    modal.querySelector(".delivera-close").onclick = close;
    modal.querySelector(".delivera-day-close-cancel").onclick = close;
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    modal.querySelector(".delivera-day-close-submit").onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Gönderiliyor...";
      try {
        workspace = await api("/api/courier/day-close", { method: "POST", body: JSON.stringify({ courierNote: modal.querySelector(".delivera-day-close-note")?.value || "" }) });
        close();
        hydrate();
        toast("Gün sonu admin Kurye Tahsilat ekranına gönderildi.");
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
        button.textContent = "Gün Sonunu Gönder";
      }
    };
    document.body.append(modal);
  }

  function hydrateProfile() {
    const courier = workspace.courier || {};
    const metrics = workspace.dayMetrics || {};
    const earnings = workspace.earningsSummary || {};
    replaceExact("Deneme 123", courier.name || "Kurye");
    updateLabelValue("Paket", metrics.deliveredCount || 0);
    updateLabelValue("Kazanç", money(earnings.today?.courierEarnings || metrics.courierEarnings || 0));
    updateLabelValue("Ekstra KM", "0.00");
    textNodes("edit").concat(textNodes("edit_square")).forEach((icon) => { const button = icon.closest("button"); if (button) button.onclick = profileSheet; });
    textNodes("Haftalık Vardiyam").forEach((label) => { const button = label.closest("button"); if (button) button.onclick = showShiftPlans; });
    textNodes("İzin Günüm").forEach((label) => { const button = label.closest("button"); if (button) button.onclick = showLeaveDays; });
    const packageHistoryButton = document.querySelector("[data-courier-package-history]");
    if (packageHistoryButton) {
      const historyCount = (workspace.historyPackages || []).length;
      packageHistoryButton.type = "button";
      packageHistoryButton.querySelector("[data-package-history-count]").textContent = `${historyCount} tamamlanan paket`;
      packageHistoryButton.onclick = () => packageSheet("history");
    }
    const dayCloseButton = document.querySelector("[data-courier-day-close]");
    if (dayCloseButton) {
      const closed = Boolean(metrics.hasClosedDay);
      dayCloseButton.disabled = false;
      dayCloseButton.classList.toggle("opacity-60", closed);
      dayCloseButton.querySelector("[data-day-close-label]").textContent = closed ? "Gün Sonu Alındı" : "Gün Sonu Al";
      dayCloseButton.querySelector("[data-day-close-caption]").textContent = closed ? "Admin tahsilatına gönderildi" : "Tahsilatı admine gönder";
      dayCloseButton.querySelector("[data-day-close-chevron]").textContent = closed ? "check_circle" : "chevron_right";
      dayCloseButton.onclick = showDayClose;
    }
    const reportTargets = {
      "Ödeme Değişikliklerim": "/courier-reports.html?view=payment-changes",
      "Üzerimdeki Nakit": "/courier-reports.html?view=cash",
      "İşletme bazlı teslim": "/courier-reports.html?view=restaurants",
      "Teslim ettiğim bakiye": "/courier-reports.html?view=settlements"
    };
    Object.entries(reportTargets).forEach(([text, target]) => textNodes(text).forEach((label) => { const button = label.closest("button"); if (button) button.onclick = () => { location.href = target; }; }));
    const main = document.querySelector("main");
    if (main && !document.querySelector("[data-delivera-logout]")) {
      const logoutButton = document.createElement("button");
      logoutButton.dataset.deliveraLogout = "1";
      logoutButton.className = "mx-margin-page mb-28 min-h-[48px] rounded-xl bg-error-container text-on-error-container font-bold";
      logoutButton.textContent = "Çıkış Yap";
      logoutButton.onclick = () => logout();
      main.append(logoutButton);
    }
  }

  function profileSheet() {
    const modal = document.createElement("div");
    modal.className = "delivera-modal";
    modal.innerHTML = `<section class="delivera-sheet"><div class="delivera-sheet-head"><h2>Profil Bilgileri</h2><button class="delivera-close">×</button></div><form class="delivera-profile-form"><label>Kullanıcı adı<input name="username" value="${esc(workspace.courier?.username || "")}" required></label><label>Yeni şifre<input name="password" type="password" placeholder="Değiştirmek için girin"></label><button class="delivera-action">Kaydet</button></form></section>`;
    modal.querySelector(".delivera-close").onclick = () => modal.remove();
    modal.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api("/api/courier/me/credentials", { method: "PUT", body: JSON.stringify({ username: form.username.value, password: form.password.value }) });
        workspace.courier.username = form.username.value;
        modal.remove();
        toast("Profil güncellendi.");
      } catch (error) { toast(error.message, "error"); }
    };
    document.body.append(modal);
  }

  function hydrateShift() {
    const available = Boolean(workspace.courier?.available);
    const currentBreak = workspace.shiftSummary?.currentBreak || null;
    const endButton = textNodes("logout")[0]?.closest("button");
    const breakButton = textNodes("local_cafe").map((icon) => icon.closest("button")).find(Boolean);
    const accidentButton = textNodes("warning")[0]?.closest("button");
    const todayKey = new Date().toDateString();
    const usedBreakMs = (workspace.shiftSummary?.recentBreaks || []).filter((item) => new Date(item.startedAt).toDateString() === todayKey).reduce((sum, item) => sum + Math.max(0, new Date(item.endedAt || Date.now()).getTime() - new Date(item.startedAt).getTime()), 0);
    const usedBreakMinutes = Math.min(5, Math.floor(usedBreakMs / 60000));
    const breakValues = { "Toplam": "5 dk", "Kullanılan": `${usedBreakMinutes} dk`, "Kalan": `${Math.max(0, 5 - usedBreakMinutes)} dk` };
    Object.entries(breakValues).forEach(([label, value]) => textNodes(label).forEach((node) => { const valueNode = node.parentElement?.querySelector(".font-label-numeric"); if (valueNode) valueNode.textContent = value; }));
    let startButton = document.querySelector(".delivera-shift-start");
    if (!startButton) {
      startButton = document.createElement("button");
      startButton.type = "button";
      startButton.className = "delivera-shift-start";
      startButton.innerHTML = '<span class="material-symbols-outlined notranslate" translate="no">play_arrow</span><span><strong>Vardiyayı Başlat</strong><small>GPS ve canlı konumu aç</small></span><span class="material-symbols-outlined notranslate" translate="no" style="margin-left:auto;background:transparent;color:#006e1c;width:auto">chevron_right</span>';
      if (accidentButton) accidentButton.insertAdjacentElement("afterend", startButton);
      else document.querySelector("main")?.append(startButton);
    }
    startButton.style.display = available ? "none" : "flex";
    startButton.dataset.deliveraAction = currentBreak ? "break-end" : "shift-start";
    startButton.querySelector("strong").textContent = currentBreak ? "Moladan Dön" : "Vardiyayı Başlat";
    startButton.querySelector("small").textContent = currentBreak ? "Tekrar paket atamasına açıl" : "GPS ve canlı konumu aç";
    if (endButton) { endButton.style.display = (available || currentBreak) ? "flex" : "none"; endButton.dataset.deliveraAction = "shift-end"; }
    if (breakButton) { breakButton.style.display = available ? "flex" : "none"; breakButton.dataset.deliveraAction = "break-start"; }
    if (accidentButton) accidentButton.dataset.deliveraAction = "emergency-call";
    startButton.onclick = async () => {
      startButton.disabled = true;
      try {
        if (currentBreak) {
          workspace = await api("/api/courier/break", { method: "POST", body: JSON.stringify({ action: "end" }) });
          startLiveLocation();
          hydrate();
          toast("Mola tamamlandı, tekrar aktifsiniz.");
        } else await toggleAvailability(true);
      }
      finally { startButton.disabled = false; }
    };
    containsText("Durum:").forEach((node) => { node.textContent = `Durum: ${currentBreak ? "MOLADA" : available ? "AKTİF" : "PASİF"}`; });
    textNodes("Vardiyayı Bitir").concat(textNodes("VardiyayÄ± Bitir")).forEach((label) => {
      const button = label.closest("button");
      if (button) button.onclick = async () => { await toggleAvailability(false); location.href = "/courier.html"; };
    });
    textNodes("Molaya Çık").concat(textNodes("Molaya Ã‡Ä±k")).forEach((label) => {
      const button = label.closest("button");
      if (button) button.onclick = async () => {
        button.disabled = true;
        try {
          workspace = await api("/api/courier/break", { method: "POST", body: JSON.stringify({ action: "start" }) });
          stopLiveLocation();
          hydrate();
          toast("Mola başladı.");
        } catch (error) { toast(error.message, "error"); }
        finally { button.disabled = false; }
      };
    });
    textNodes("Kaza Bildirimi").forEach((label) => { const button = label.closest("button"); if (button) button.onclick = callManager; });
  }

  async function hydrate() {
    if (!workspace) return;
    if (route === "/courier.html") await hydrateMap();
    if (route === "/courier-reports.html") hydrateReports();
    if (route === "/courier-profile.html") hydrateProfile();
    if (route === "/courier-shift.html") hydrateShift();
  }

  async function loadWorkspace() {
    if (!token()) return showLogin();
    try {
      workspace = await api("/api/courier/me?limit=100&cursor=0");
      processIncomingAssignments(workspace);
      await hydrate();
      connectEventStream();
      initializeCourierPush();
      revealCourierApp();
      if (!document.body.dataset.pushLinkHandled) {
        document.body.dataset.pushLinkHandled = "1";
        const query = new URLSearchParams(location.search);
        if (query.has("package")) packageSheet();
        else if (query.has("notifications")) showNotificationCenter();
      }
    } catch (error) {
      if (token()) toast(error.message, "error");
      revealCourierApp();
    }
  }

  document.documentElement.lang = "tr";
  document.documentElement.setAttribute("translate", "no");
  document.body.classList.add("delivera-mobile-layout");
  all(".material-symbols-outlined").forEach((icon) => {
    icon.classList.add("notranslate");
    icon.setAttribute("translate", "no");
  });
  addIntegrationStyle();
  installAppShell();
  if (globalThis.__DELIVERA_TEST__) globalThis.__courierDesignTest = { packageSheet, reportPackages, refreshCourierMapData };
  document.addEventListener("pointerdown", unlockAssignmentAudio, { once: true, capture: true });
  bindNavigation();
  // Giriş yapılmış kurye sayfalarında statik arayüzü API yanıtını bekletmeden
  // göster. Canlı veriler geldiğinde hydrate() alanları yerinde günceller.
  // Böylece özellikle Ayarlar/Raporlar geçişinde yükleme perdesi takılı kalmaz.
  if (token()) revealCourierApp();
  loadWorkspace();
  if (!globalThis.__DELIVERA_TEST__) pollId = window.setInterval(loadWorkspace, 12000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { startLiveLocation(); pushLiveLocationHeartbeat(); scheduleCourierMapRefresh(); }
  });
  if (!globalThis.__DELIVERA_TEST__ && route === '/courier.html') window.setInterval(() => { updateGpsStatus(); if (workspace?.courier?.available && mapWatchId === null) startLiveLocation(); }, 5000);
  window.addEventListener('online', () => { routeRetryAt = 1; startLiveLocation(); scheduleCourierMapRefresh(); });
  window.addEventListener("focus", pushLiveLocationHeartbeat);
  window.addEventListener("online", pushLiveLocationHeartbeat);
  window.addEventListener("beforeunload", () => { window.clearInterval(pollId); window.clearInterval(courierMapPoll); window.clearTimeout(courierMapRefreshTimer); stopLiveLocation(); eventStream?.close(); });
})();
