const DEFAULT_BACKEND_URL = "";
const shared = globalThis.DeliveraExtensionShared;
const STORAGE_KEYS = {
  backendUrl: "deliveraBackendUrl",
  restaurantToken: "deliveraRestaurantToken",
  platform: "deliveraPlatform",
  autoEnabled: "deliveraAutoEnabled",
  autoWatcherEnabled: "autoWatcherEnabled",
  testMode: "deliveraTestMode",
  lastCandidate: "deliveraAutoLastCandidate",
  lastPostStatus: "deliveraAutoLastStatus",
  lastError: "deliveraAutoLastError",
  sentCount: "deliveraSentCount",
  duplicateCount: "deliveraAutoDuplicateCount",
  lastRawText: "deliveraAutoLastRawText",
  lastDedupeKey: "deliveraAutoLastDedupeKey",
};
const WATCHER_BLOCK_MESSAGE = "Otomatik izleme desteklenmeyen sayfada kapali";
const TEST_MODE_ACTIVE_MESSAGE = "Otomatik izleme acildi";

const refs = {
  backendUrl: document.getElementById("backendUrl"),
  restaurantToken: document.getElementById("restaurantToken"),
  platformSelect: document.getElementById("platformSelect"),
  autoWatchToggle: document.getElementById("autoWatchToggle"),
  testModeToggle: document.getElementById("testModeToggle"),
  sendButton: document.getElementById("sendButton"),
  copyButton: document.getElementById("copyButton"),
  clearAutoCacheButton: document.getElementById("clearAutoCacheButton"),
  statusText: document.getElementById("statusText"),
  detectedPlatformText: document.getElementById("detectedPlatformText"),
  testModeCard: document.getElementById("testModeCard"),
  testModeText: document.getElementById("testModeText"),
  lastCandidateText: document.getElementById("lastCandidateText"),
  lastPostStatus: document.getElementById("lastPostStatus"),
  lastErrorText: document.getElementById("lastErrorText"),
  sentCountText: document.getElementById("sentCountText"),
  duplicateCountText: document.getElementById("duplicateCountText"),
};

console.log("extension popup loaded");

function setTextIfChanged(node, value) {
  const nextValue = String(value ?? "");
  if (node.textContent !== nextValue) {
    node.textContent = nextValue;
  }
}

function setValueIfChanged(node, value) {
  const nextValue = String(value ?? "");
  if (node.value !== nextValue) {
    node.value = nextValue;
  }
}

function setCheckedIfChanged(node, checked) {
  const nextValue = Boolean(checked);
  if (node.checked !== nextValue) {
    node.checked = nextValue;
  }
}

function setHiddenIfChanged(node, hidden) {
  const nextValue = Boolean(hidden);
  if (node.hidden !== nextValue) {
    node.hidden = nextValue;
  }
}

function setStatus(message, tone = "info") {
  setTextIfChanged(refs.statusText, message);
  if (refs.statusText.dataset.tone !== tone) {
    refs.statusText.dataset.tone = tone;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("Aktif sekme bulunamadi.");
  }
  return tab;
}

async function getStorageSnapshot() {
  return chrome.storage.local.get(Object.values(STORAGE_KEYS));
}

async function saveStorageIfChanged(values) {
  const current = await getStorageSnapshot();
  const nextValues = {};
  Object.entries(values).forEach(([key, value]) => {
    if (current[key] !== value) {
      nextValues[key] = value;
    }
  });
  if (Object.keys(nextValues).length > 0) {
    await chrome.storage.local.set(nextValues);
  }
}

async function saveSettings() {
  const autoEnabled = Boolean(refs.autoWatchToggle.checked);
  await saveStorageIfChanged({
    [STORAGE_KEYS.backendUrl]: refs.backendUrl.value.trim() || DEFAULT_BACKEND_URL,
    [STORAGE_KEYS.restaurantToken]: refs.restaurantToken.value.trim(),
    [STORAGE_KEYS.platform]: refs.platformSelect.value,
    [STORAGE_KEYS.autoEnabled]: autoEnabled,
    [STORAGE_KEYS.autoWatcherEnabled]: autoEnabled,
    [STORAGE_KEYS.testMode]: Boolean(refs.testModeToggle.checked),
  });
}

function renderTestMode(enabled) {
  const isEnabled = Boolean(enabled);
  setCheckedIfChanged(refs.testModeToggle, isEnabled);
  setHiddenIfChanged(refs.testModeCard, !isEnabled);
  setTextIfChanged(refs.testModeText, isEnabled ? "Test modu aktif" : "");
}

function renderAutoState(saved = {}) {
  setTextIfChanged(refs.lastCandidateText, saved[STORAGE_KEYS.lastCandidate] || "Henuz yok");
  setTextIfChanged(refs.lastPostStatus, saved[STORAGE_KEYS.lastPostStatus] || "Henuz yok");
  setTextIfChanged(refs.lastErrorText, saved[STORAGE_KEYS.lastError] || "Yok");
  setTextIfChanged(refs.sentCountText, String(saved[STORAGE_KEYS.sentCount] || 0));
  setTextIfChanged(refs.duplicateCountText, String(saved[STORAGE_KEYS.duplicateCount] || 0));
}

function renderDetectedPlatform(url = "") {
  const detectedPlatform = shared.detectPlatformFromUrl(url);
  setTextIfChanged(refs.detectedPlatformText, detectedPlatform);
  return detectedPlatform;
}

function describeCurrentPage(url = "", testMode = false) {
  const supported = shared.isAllowedAutoWatchUrl(url, testMode);
  console.log("current url", url || "(bos)");
  console.log("testMode value", Boolean(testMode));
  console.log("supported platform result", supported);
  return supported;
}

async function reconcilePageState(activeTab, saved) {
  const currentUrl = activeTab?.url || "";
  const testMode = Boolean(saved[STORAGE_KEYS.testMode]);
  const autoEnabled = Boolean(saved[STORAGE_KEYS.autoEnabled]);
  const isAllowed = describeCurrentPage(currentUrl, testMode);
  const nextState = {};

  if (autoEnabled && isAllowed) {
    if (
      saved[STORAGE_KEYS.lastPostStatus] === WATCHER_BLOCK_MESSAGE ||
      saved[STORAGE_KEYS.lastError] === "Bu sayfa desteklenen platform degil"
    ) {
      nextState[STORAGE_KEYS.lastPostStatus] = TEST_MODE_ACTIVE_MESSAGE;
      nextState[STORAGE_KEYS.lastError] = "";
    }
    setStatus(testMode && shared.isTestAutoPage(currentUrl) ? "Test modu aktif" : TEST_MODE_ACTIVE_MESSAGE, "success");
  } else if (autoEnabled && !isAllowed) {
    setStatus("Bu sayfa desteklenen platform degil", "warn");
  } else if (testMode) {
    setStatus("Test modu aktif", "info");
  }

  if (Object.keys(nextState).length > 0) {
    await saveStorageIfChanged(nextState);
  }
}

async function clearAutoWatcherCache() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.sentCount,
    STORAGE_KEYS.duplicateCount,
    STORAGE_KEYS.lastRawText,
    STORAGE_KEYS.lastDedupeKey,
  ]);
  await saveStorageIfChanged({
    [STORAGE_KEYS.sentCount]: 0,
    [STORAGE_KEYS.duplicateCount]: 0,
    [STORAGE_KEYS.lastCandidate]: "Henuz yok",
    [STORAGE_KEYS.lastPostStatus]: "Test gonderim gecmisi temizlendi",
    [STORAGE_KEYS.lastError]: "",
  });
  await chrome.storage.local.set({
    deliveraSentOrderKeys: {},
    deliveraProcessedOrderKeys: {},
  });
  setStatus("Test gonderim gecmisi temizlendi", "success");
}

async function loadSettings() {
  const saved = await getStorageSnapshot();
  const activeTab = await getActiveTab().catch(() => null);
  const detectedPlatform = renderDetectedPlatform(activeTab?.url || "");

  setValueIfChanged(refs.backendUrl, saved[STORAGE_KEYS.backendUrl] || DEFAULT_BACKEND_URL);
  setValueIfChanged(refs.restaurantToken, saved[STORAGE_KEYS.restaurantToken] || "");
  setValueIfChanged(refs.platformSelect, saved[STORAGE_KEYS.platform] || detectedPlatform);
  setCheckedIfChanged(refs.autoWatchToggle, Boolean(saved[STORAGE_KEYS.autoEnabled]));
  renderTestMode(Boolean(saved[STORAGE_KEYS.testMode]));
  renderAutoState(saved);
  await reconcilePageState(activeTab, saved);
}

async function extractOrderPayload(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shared.js", "content.js"],
  });
  const response = await chrome.tabs.sendMessage(tabId, { type: "DELIVERA_EXTRACT_ORDER" });
  if (!response?.ok || !response.rawText) {
    throw new Error(response?.error || "Sayfadan siparis metni alinamadi.");
  }
  return response;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

async function postToDelivera(rawText, source = "platform_extension", dedupeKey = "") {
  await saveSettings();
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage kullanilamiyor."));
      return;
    }
    chrome.runtime.sendMessage({
      type: "DELIVERA_MANUAL_POST",
      payload: {
        rawText,
        source,
        sourcePlatform: refs.platformSelect.value,
        dedupeKey,
      },
    }, (response) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(`manual: ${runtimeError.message}`));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "manual: background post failed"));
        return;
      }
      resolve(response.data);
    });
  });
}

async function handleSend() {
  let extracted = null;
  try {
    await saveSettings();
    setStatus("Sayfadaki siparis okunuyor...");
    const tab = await getActiveTab();
    extracted = await extractOrderPayload(tab.id);
    await postToDelivera(extracted.rawText, "platform_extension", extracted.manualDedupeKey);
    await saveStorageIfChanged({
      [STORAGE_KEYS.lastError]: "",
      [STORAGE_KEYS.lastPostStatus]: "Manuel gonderim basarili",
    });
    setStatus("RESTOMAP'e gönderildi", "success");
  } catch (error) {
    await saveStorageIfChanged({
      [STORAGE_KEYS.lastError]: error.message || "Manuel gonderim basarisiz",
      [STORAGE_KEYS.lastPostStatus]: "Manuel gonderim hata verdi",
    });
    try {
      if (!extracted) {
        const tab = await getActiveTab();
        extracted = await extractOrderPayload(tab.id);
      }
      await copyText(extracted.rawText);
      setStatus("API'ye gönderilemedi ama metin kopyalandı. RESTOMAP paneline yapıştırabilirsin.", "warn");
    } catch (fallbackError) {
      setStatus(fallbackError.message || error.message || "Islem basarisiz.", "error");
    }
  }
}

async function handleCopyOnly() {
  try {
    await saveSettings();
    const tab = await getActiveTab();
    const extracted = await extractOrderPayload(tab.id);
    await copyText(extracted.rawText);
    setStatus("Siparis metni kopyalandi", "success");
  } catch (error) {
    setStatus(error.message || "Metin kopyalanamadi.", "error");
  }
}

async function handleAutoToggle() {
  const token = shared.normalizeToken(refs.restaurantToken.value);
  const backendUrl = refs.backendUrl.value.trim();
  const activeTab = await getActiveTab().catch(() => null);
  const currentUrl = activeTab?.url || "";
  const testMode = refs.testModeToggle.checked;
  const isSupportedPlatform = describeCurrentPage(currentUrl, testMode);
  renderDetectedPlatform(currentUrl);

  if (refs.autoWatchToggle.checked && !backendUrl) {
    setCheckedIfChanged(refs.autoWatchToggle, false);
    setStatus("Backend URL gerekli", "error");
    await saveStorageIfChanged({
      [STORAGE_KEYS.autoEnabled]: false,
      [STORAGE_KEYS.lastError]: "Backend URL gerekli",
      [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme baslatilamadi",
    });
    return;
  }

  if (refs.autoWatchToggle.checked && !token) {
    setCheckedIfChanged(refs.autoWatchToggle, false);
    setStatus("Restaurant Token gerekli", "error");
    await saveStorageIfChanged({
      [STORAGE_KEYS.autoEnabled]: false,
      [STORAGE_KEYS.lastError]: "Restaurant Token gerekli",
      [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme baslatilamadi",
    });
    return;
  }

  if (refs.autoWatchToggle.checked && !isSupportedPlatform) {
    setCheckedIfChanged(refs.autoWatchToggle, false);
    setStatus("Bu sayfa desteklenen platform degil", "warn");
    await saveStorageIfChanged({
      [STORAGE_KEYS.autoEnabled]: false,
      [STORAGE_KEYS.lastError]: "Bu sayfa desteklenen platform degil",
      [STORAGE_KEYS.lastPostStatus]: WATCHER_BLOCK_MESSAGE,
    });
    return;
  }

  await saveSettings();
  if (refs.autoWatchToggle.checked) {
    await saveStorageIfChanged({
      [STORAGE_KEYS.lastError]: "",
      [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme acildi",
    });
  }
  setStatus(refs.autoWatchToggle.checked ? "Otomatik izleme acildi" : "Otomatik izleme kapatildi", refs.autoWatchToggle.checked ? "success" : "info");
}

async function handleTestModeToggle() {
  const activeTab = await getActiveTab().catch(() => null);
  const currentUrl = activeTab?.url || "";
  renderTestMode(refs.testModeToggle.checked);
  await saveSettings();

  if (refs.testModeToggle.checked) {
    const allowed = describeCurrentPage(currentUrl, true);
    if (refs.autoWatchToggle.checked && allowed) {
      await saveStorageIfChanged({
        [STORAGE_KEYS.lastError]: "",
        [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme acildi",
      });
    }
    setStatus("Test modu aktif", "info");
    return;
  }

  if (refs.autoWatchToggle.checked) {
    await handleAutoToggle();
  } else {
    setStatus("Test modu kapatildi", "info");
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEYS.lastCandidate]) {
    setTextIfChanged(refs.lastCandidateText, changes[STORAGE_KEYS.lastCandidate].newValue || "Henuz yok");
  }
  if (changes[STORAGE_KEYS.lastPostStatus]) {
    setTextIfChanged(refs.lastPostStatus, changes[STORAGE_KEYS.lastPostStatus].newValue || "Henuz yok");
  }
  if (changes[STORAGE_KEYS.lastError]) {
    setTextIfChanged(refs.lastErrorText, changes[STORAGE_KEYS.lastError].newValue || "Yok");
  }
  if (changes[STORAGE_KEYS.sentCount]) {
    setTextIfChanged(refs.sentCountText, String(changes[STORAGE_KEYS.sentCount].newValue || 0));
  }
  if (changes[STORAGE_KEYS.duplicateCount]) {
    setTextIfChanged(refs.duplicateCountText, String(changes[STORAGE_KEYS.duplicateCount].newValue || 0));
  }
  if (changes[STORAGE_KEYS.testMode]) {
    renderTestMode(Boolean(changes[STORAGE_KEYS.testMode].newValue));
  }
  if (changes[STORAGE_KEYS.autoEnabled]) {
    setCheckedIfChanged(refs.autoWatchToggle, Boolean(changes[STORAGE_KEYS.autoEnabled].newValue));
  }
});

refs.sendButton.addEventListener("click", handleSend);
refs.copyButton.addEventListener("click", handleCopyOnly);
refs.clearAutoCacheButton.addEventListener("click", clearAutoWatcherCache);
refs.autoWatchToggle.addEventListener("change", handleAutoToggle);
refs.testModeToggle.addEventListener("change", handleTestModeToggle);
refs.backendUrl.addEventListener("change", saveSettings);
refs.restaurantToken.addEventListener("change", saveSettings);
refs.platformSelect.addEventListener("change", saveSettings);

loadSettings().catch(() => {
  setStatus("Ayarlar yuklenemedi.", "warn");
});
