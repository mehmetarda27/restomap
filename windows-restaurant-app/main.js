const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { applyPaperSize, normalizePaperSize, printerLabel, selectPrinter } = require("./printer-service");

const PANEL_URL = "https://deliveraexpres.com.tr/restaurant.html";
const ALLOWED_ORIGIN = "https://deliveraexpres.com.tr";
const PRINT_HISTORY_LIMIT = 2000;
let mainWindow;
let tray;
let quitting = false;
const printJobs = new Map();
const printFailureNotified = new Set();

function historyPath() {
  return path.join(app.getPath("userData"), "printed-orders.json");
}

function pendingJobsPath() {
  return path.join(app.getPath("userData"), "pending-print-jobs.json");
}

function printerSettingsPath() {
  return path.join(app.getPath("userData"), "printer-settings.json");
}

function readPrinterSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(printerSettingsPath(), "utf8"));
    return {
      deviceName: String(parsed?.deviceName || ""),
      displayName: String(parsed?.displayName || ""),
      paperSize: normalizePaperSize(parsed?.paperSize),
    };
  } catch {
    return { deviceName: "", displayName: "", paperSize: "80mm" };
  }
}

function writePrinterSettings(settings) {
  const next = {
    deviceName: String(settings?.deviceName || ""),
    displayName: String(settings?.displayName || ""),
    paperSize: normalizePaperSize(settings?.paperSize),
  };
  fs.writeFileSync(printerSettingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function availablePrinters() {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  return mainWindow.webContents.getPrintersAsync();
}

async function resolvePrinter({ forgetSaved = false } = {}) {
  const settings = readPrinterSettings();
  const printers = await availablePrinters();
  const selected = selectPrinter(printers, forgetSaved ? "" : settings.deviceName);
  if (!selected.printer) throw new Error("Windows'ta kullanılabilir fiziksel yazıcı bulunamadı");
  const next = writePrinterSettings({
    ...settings,
    deviceName: selected.printer.name,
    displayName: printerLabel(selected.printer),
  });
  return { ...selected, settings: next };
}

function readPrintedOrders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function markPrinted(packageId) {
  const next = [...new Set([...readPrintedOrders(), String(packageId)])].slice(-PRINT_HISTORY_LIMIT);
  fs.writeFileSync(historyPath(), JSON.stringify(next, null, 2), "utf8");
}

function readPendingJobs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingJobsPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => item?.packageId && item?.html) : [];
  } catch {
    return [];
  }
}

function writePendingJobs(jobs) {
  fs.writeFileSync(pendingJobsPath(), JSON.stringify(jobs.slice(-500), null, 2), "utf8");
}

function queuePrint(payload) {
  const packageId = String(payload?.packageId || "").trim();
  const html = String(payload?.html || "");
  if (!packageId || !html) return Promise.reject(new Error("Eksik fiş verisi"));
  if (readPrintedOrders().includes(packageId)) return Promise.resolve({ ok: true, duplicate: true });
  const pending = readPendingJobs().filter((item) => String(item.packageId) !== packageId);
  pending.push({ ...payload, packageId, queuedAt: new Date().toISOString() });
  writePendingJobs(pending);
  return silentPrint({ ...payload, packageId });
}

function removePendingJob(packageId) {
  writePendingJobs(readPendingJobs().filter((item) => String(item.packageId) !== String(packageId)));
}

function retryPendingPrints() {
  readPendingJobs().forEach((payload) => silentPrint(payload).catch(() => {}));
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({
    title: String(title || "Delivera Restoran"),
    body: String(body || "Yeni sipariş geldi."),
    silent: false,
    timeoutType: "never",
    icon: path.join(__dirname, "assets", "delivera.png"),
  }).show();
}

async function silentPrint(payload) {
  const packageId = String(payload?.packageId || "").trim();
  const html = String(payload?.html || "");
  if (!packageId || !html) throw new Error("Eksik fiş verisi");
  if (readPrintedOrders().includes(packageId)) return { ok: true, duplicate: true };
  if (printJobs.has(packageId)) return printJobs.get(packageId);

  const job = new Promise(async (resolve, reject) => {
    let selected;
    try {
      selected = await resolvePrinter();
    } catch (error) {
      notify("Fiş yazıcısı bulunamadı", `${error.message}. Delivera simgesine sağ tıklayıp Yazıcı Seç'i kullanın.`);
      reject(error);
      return;
    }
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    });
    let finished = false;
    const finish = (error, result = { ok: true, duplicate: false }) => {
      if (finished) return;
      finished = true;
      if (!printWindow.isDestroyed()) printWindow.destroy();
      if (error) reject(error); else resolve(result);
    };
    printWindow.webContents.once("did-finish-load", () => {
      const printTimeout = setTimeout(() => finish(new Error("Yazdırma zaman aşımına uğradı")), 20000);
      printWindow.webContents.print({
        silent: true,
        printBackground: true,
        deviceName: selected.printer.name,
      }, (success, failureReason) => {
        clearTimeout(printTimeout);
        if (finished) return;
        if (!success) {
          if (!printFailureNotified.has(packageId)) {
            printFailureNotified.add(packageId);
            notify("Fiş yazdırılamadı", `${payload?.trackingNo || packageId}: ${selected.settings.displayName} · ${failureReason || "Yazıcı bağlantısı kontrol edilmeli."} Bağlantı düzelince tekrar denenecek.`);
          }
          finish(new Error(failureReason || "Yazdırma başarısız"));
          return;
        }
        markPrinted(packageId);
        removePendingJob(packageId);
        printFailureNotified.delete(packageId);
        finish(null, { ok: true, duplicate: false, printer: selected.settings.displayName });
      });
    });
    printWindow.webContents.once("did-fail-load", (_event, code, description) => finish(new Error(`${code}: ${description}`)));
    const printableHtml = applyPaperSize(html, selected.settings.paperSize);
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printableHtml)}`).catch(finish);
  }).finally(() => printJobs.delete(packageId));
  printJobs.set(packageId, job);
  return job;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "delivera.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:delivera-restaurant",
      backgroundThrottling: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    notify("Delivera arka planda çalışıyor", "Yeni siparişler izlenmeye ve otomatik yazdırılmaya devam edecek.");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ALLOWED_ORIGIN)) return { action: "allow" };
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["notifications", "geolocation"].includes(permission));
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ALLOWED_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    mainWindow.loadFile(path.join(__dirname, "offline.html"), { query: { message: description, target: url || PANEL_URL } });
  });
  mainWindow.webContents.once("did-finish-load", () => {
    const previousDevice = readPrinterSettings().deviceName;
    setTimeout(async () => {
      const selected = await autoConfigurePrinter(false);
      if (selected && previousDevice !== selected.settings.deviceName) {
        notify("Fiş yazıcısı hazır", `${selected.settings.displayName} otomatik seçildi. Test için tepsi simgesini kullanabilirsiniz.`);
      }
    }, 1500);
  });
  mainWindow.loadURL(PANEL_URL);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "delivera.ico")));
  tray.setToolTip("Delivera Restoran");
  refreshTrayMenu();
  tray.on("double-click", () => { mainWindow.show(); mainWindow.focus(); });
}

function refreshTrayMenu() {
  if (!tray) return;
  const settings = readPrinterSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Paneli Aç", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: "Paneli Yenile", click: () => mainWindow.loadURL(PANEL_URL) },
    { type: "separator" },
    { label: `Yazıcı: ${settings.displayName || "Otomatik seçilecek"}`, enabled: false },
    { label: "Yazıcı Seç", click: () => choosePrinter().catch((error) => notify("Yazıcı seçilemedi", error.message)) },
    { label: "Termal Yazıcıyı Otomatik Bul", click: () => autoConfigurePrinter(true, true) },
    { label: `Kağıt: ${settings.paperSize}`, submenu: [
      { label: "58 mm", type: "radio", checked: settings.paperSize === "58mm", click: () => setPaperSize("58mm") },
      { label: "80 mm", type: "radio", checked: settings.paperSize === "80mm", click: () => setPaperSize("80mm") },
      { label: "A4", type: "radio", checked: settings.paperSize === "a4", click: () => setPaperSize("a4") },
    ] },
    { label: "Test Fişi Yazdır", click: () => printTestReceipt() },
    { type: "separator" },
    { label: "Çıkış", click: () => { quitting = true; app.quit(); } },
  ]));
}

function setPaperSize(paperSize) {
  writePrinterSettings({ ...readPrinterSettings(), paperSize });
  refreshTrayMenu();
  notify("Kağıt ölçüsü kaydedildi", `${normalizePaperSize(paperSize)} fiş düzeni kullanılacak.`);
}

async function autoConfigurePrinter(showResult = false, forgetSaved = false) {
  try {
    const selected = await resolvePrinter({ forgetSaved });
    refreshTrayMenu();
    if (showResult) notify("Fiş yazıcısı hazır", `${selected.settings.displayName} otomatik seçildi.`);
    return selected;
  } catch (error) {
    if (showResult) notify("Fiş yazıcısı bulunamadı", error.message);
    return null;
  }
}

async function choosePrinter() {
  const printers = (await availablePrinters()).filter((printer) => !/pdf|xps|onenote|fax|document writer/i.test(`${printer.name} ${printer.displayName || ""}`));
  if (!printers.length) throw new Error("Windows'ta fiziksel yazıcı bulunamadı");
  const cancelId = printers.length;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Delivera Fiş Yazıcısı",
    message: "Fişlerin otomatik gönderileceği yazıcıyı seçin",
    detail: "Bu seçim bu bilgisayarda saklanır. SepetTakip'in ayarları değişmez.",
    buttons: [...printers.map(printerLabel), "İptal"],
    cancelId,
    defaultId: 0,
    noLink: true,
  });
  if (result.response === cancelId) return null;
  const printer = printers[result.response];
  const settings = writePrinterSettings({
    ...readPrinterSettings(),
    deviceName: printer.name,
    displayName: printerLabel(printer),
  });
  refreshTrayMenu();
  notify("Fiş yazıcısı kaydedildi", `${settings.displayName} bundan sonra otomatik kullanılacak.`);
  return settings;
}

function printTestReceipt() {
  const now = new Date();
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>body{font:14px Arial;text-align:center}h1{font-size:20px;border-bottom:2px dashed #000;padding-bottom:8px}p{margin:8px 0}</style></head><body><h1>RESTOMAP</h1><p><b>YAZICI TESTİ BAŞARILI</b></p><p>${now.toLocaleString("tr-TR")}</p><p>Otomatik fiş sistemi hazır.</p></body></html>`;
  silentPrint({ packageId: `printer-test-${Date.now()}`, trackingNo: "TEST FİŞİ", html })
    .then((result) => notify("Test fişi gönderildi", `${result.printer || "Seçili yazıcı"} baskı işini kabul etti.`))
    .catch((error) => notify("Test fişi başarısız", error.message));
}

function isTrustedRenderer(event) {
  return String(event.senderFrame?.url || "").startsWith(ALLOWED_ORIGIN);
}

ipcMain.handle("delivera:auto-print-receipt", (event, payload) => {
  if (!isTrustedRenderer(event)) throw new Error("Yetkisiz yazdırma isteği");
  return queuePrint(payload);
});
ipcMain.handle("delivera:notification", (event, payload) => {
  if (!isTrustedRenderer(event)) throw new Error("Yetkisiz bildirim isteği");
  notify(payload?.title, payload?.body);
  return { ok: true };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    app.setAppUserModelId("tr.com.deliveraexpres.restaurant");
    app.setLoginItemSettings({ openAtLogin: true, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath });
    createWindow();
    createTray();
    setTimeout(retryPendingPrints, 5000);
    setInterval(retryPendingPrints, 30000).unref();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => { quitting = true; });
}
