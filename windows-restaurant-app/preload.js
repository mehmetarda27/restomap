const { contextBridge, ipcRenderer } = require("electron");

let webBridgeReady = false;
let fallbackStarted = false;
let knownPackageIds = null;
let polling = false;

const terminalStatuses = new Set(["delivered", "failed", "rejected", "cancelled", "canceled"]);
const safe = (value) => String(value ?? "").replace(/[&<>\"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const money = (value) => `${Number(value || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
const localized = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value).trim();
  return String(value.tr || value.en || value.default || value.text || value.name || Object.values(value).find((entry) => typeof entry === "string") || "").trim();
};

function orderItems(pkg) {
  const raw = pkg?.rawPayload && typeof pkg.rawPayload === "object" ? pkg.rawPayload : {};
  const candidates = [pkg?.items, raw.items, raw.products, raw.lines, raw.order?.items, raw.order?.products, raw.data?.items, raw.data?.products];
  const source = candidates.find((candidate) => Array.isArray(candidate) && candidate.length) || [];
  return source.map((item, index) => {
    const entry = item && typeof item === "object" ? item : { name: item };
    const quantity = Math.max(1, Number(entry.quantity ?? entry.qty ?? entry.count ?? 1) || 1);
    const unitPrice = Number(entry.unitPrice ?? entry.unit_price ?? entry.price);
    const explicitTotal = Number(entry.total ?? entry.totalPrice ?? entry.total_price ?? entry.priceWithOption ?? entry.price_with_option);
    const total = Number.isFinite(explicitTotal) ? explicitTotal : Number.isFinite(unitPrice) ? unitPrice * quantity : null;
    const choices = (value) => (Array.isArray(value) ? value : []).map((choice) => localized(choice?.name ?? choice?.title ?? choice)).filter(Boolean);
    const extras = choices(entry.extraIngredients ?? entry.extra_ingredients ?? entry.extras ?? entry.options ?? entry.modifiers);
    const removed = choices(entry.removedIngredients ?? entry.removed_ingredients);
    const note = localized(entry.note ?? entry.description);
    return {
      quantity,
      name: localized(entry.name ?? entry.productName ?? entry.title ?? entry.product) || `Ürün ${index + 1}`,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
      total,
      details: [extras.length ? `Ekstra: ${extras.join(", ")}` : "", removed.length ? `Çıkarılan: ${removed.join(", ")}` : "", note ? `Not: ${note}` : ""].filter(Boolean),
    };
  });
}

function receiptHtml(pkg, restaurantName, settings = {}) {
  const paperSize = String(settings.paperSize || "80mm").toLowerCase();
  const width = paperSize === "58mm" ? "54mm" : paperSize === "a4" ? "190mm" : "76mm";
  const copies = Math.max(1, Math.min(5, Number(settings.copies) || 1));
  const items = orderItems(pkg);
  const receipt = (copy) => `<article class="receipt${copy < copies ? " page" : ""}">
    <header><h1>RESTOMAP</h1><h2>${safe(restaurantName || "Restoran")}</h2><b>${safe(pkg.trackingNo || pkg.externalOrderNo || pkg.id)}</b></header>
    <div class="row"><b>Müşteri</b><span>${safe(pkg.customerName || "-")}</span></div><div class="row"><b>Telefon</b><span>${safe(pkg.phone || "-")}</span></div><div class="row"><b>Ödeme</b><span>${safe(pkg.paymentMethod || "-")} · ${safe(money(pkg.orderAmount))}</span></div>
    <section><h3>SİPARİŞ İÇERİĞİ</h3>${items.length ? items.map((item) => `<div class="item"><div><b>${item.quantity}× ${safe(item.name)}</b>${item.unitPrice !== null ? `<small>Birim: ${safe(money(item.unitPrice))}</small>` : ""}${item.details.map((detail) => `<small>${safe(detail)}</small>`).join("")}</div><strong>${item.total === null ? "-" : safe(money(item.total))}</strong></div>`).join("") : `<p>Ürün bilgisi platformdan gelmedi.</p>`}</section>
    <section><h3>TESLİMAT ADRESİ</h3><p>${safe(pkg.deliveryAddress || "-")}</p></section>${pkg.customerNote ? `<section><h3>MÜŞTERİ NOTU</h3><p>${safe(pkg.customerNote)}</p></section>` : ""}<footer>RESTOMAP altyapısıyla yönetilmektedir.${copies > 1 ? `<br>Kopya ${copy}/${copies}` : ""}</footer></article>`;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>@page{size:${paperSize === "a4" ? "A4 portrait" : `${paperSize} auto`};margin:${paperSize === "a4" ? "10mm" : "0"}}*{box-sizing:border-box}body{width:${width};margin:auto;padding:2mm;color:#111;font:12px Arial,sans-serif}.receipt{width:100%}.page{page-break-after:always}header{text-align:center;border:2px solid #111;padding:7px;margin-bottom:8px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:4px 0}.row,.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:6px 0;border-bottom:1px dashed #888}.row span{text-align:right}section{margin-top:8px;border:1px solid #555;padding:6px}h3{font-size:12px;text-align:center;margin:0 0 5px}.item small{display:block;font-size:10px}p{margin:4px 0;overflow-wrap:anywhere}footer{text-align:center;border-top:2px solid #111;margin-top:10px;padding-top:7px;font-weight:bold}</style></head><body>${Array.from({ length: copies }, (_, index) => receipt(index + 1)).join("")}</body></html>`;
}

async function pollOrders() {
  if (polling || webBridgeReady || !["https://restomap.onrender.com", "https://restomap.com.tr", "https://www.restomap.com.tr"].includes(location.origin)) return;
  const token = localStorage.getItem("restomapRestaurantToken") || localStorage.getItem("deliveraRestaurantToken");
  if (!token) return;
  polling = true;
  try {
    const [bootstrapResponse, settingsResponse] = await Promise.all([
      fetch("/api/restaurant/bootstrap?limit=250&cursor=0", { headers: { Authorization: `Bearer ${token}` } }),
      fetch("/api/restaurant/panel-data", { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (!bootstrapResponse.ok) return;
    const data = await bootstrapResponse.json();
    const settingsPayload = settingsResponse.ok ? await settingsResponse.json() : {};
    const packages = Array.isArray(data.packages) ? data.packages : [];
    const currentIds = new Set(packages.map((pkg) => String(pkg.id || pkg.trackingNo || pkg.externalOrderNo || "")).filter(Boolean));
    if (knownPackageIds === null) {
      knownPackageIds = currentIds;
      return;
    }
    const incoming = packages.filter((pkg) => {
      const id = String(pkg.id || pkg.trackingNo || pkg.externalOrderNo || "");
      return id && !knownPackageIds.has(id) && !terminalStatuses.has(String(pkg.status || "").toLowerCase());
    });
    knownPackageIds = currentIds;
    const restaurantName = data.restaurants?.[0]?.name || "Restoran";
    const printerSettings = settingsPayload.data?.printerSettings || {};
    for (const pkg of incoming) {
      const packageId = String(pkg.id || pkg.trackingNo || pkg.externalOrderNo);
      await ipcRenderer.invoke("delivera:notification", { title: "RESTOMAP - Yeni Sipariş", body: `${pkg.trackingNo || packageId} · ${pkg.customerName || "Müşteri"}` });
      await ipcRenderer.invoke("delivera:auto-print-receipt", { packageId, trackingNo: pkg.trackingNo || packageId, customerName: pkg.customerName || "Müşteri", html: receiptHtml(pkg, restaurantName, printerSettings) }).catch(() => {});
    }
  } catch {
  } finally {
    polling = false;
  }
}

function startFallbackWatcher() {
  if (fallbackStarted) return;
  fallbackStarted = true;
  setInterval(pollOrders, 5000);
  pollOrders();
}

window.addEventListener("DOMContentLoaded", () => setTimeout(() => { if (!webBridgeReady) startFallbackWatcher(); }, 8000));

contextBridge.exposeInMainWorld("deliveraDesktop", Object.freeze({
  platform: "windows",
  markBridgeReady: () => { webBridgeReady = true; return true; },
  autoPrintReceipt: (payload) => ipcRenderer.invoke("delivera:auto-print-receipt", payload),
  showNotification: (payload) => ipcRenderer.invoke("delivera:notification", payload),
}));
