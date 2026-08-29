(function initDeliveraExtensionShared(globalScope) {
  const ACCEPTED_KEYWORDS = [
    "kabul edildi",
    "onaylandi",
    "onaylandı",
    "hazirlaniyor",
    "hazırlanıyor",
    "accepted",
    "confirmed",
    "preparing",
    "approved",
    "in preparation",
  ];
  const PENDING_KEYWORDS = [
    "yeni siparis",
    "yeni sipariş",
    "new order",
    "siparis geldi",
    "sipariş geldi",
    "order received",
    "pending",
    "bekliyor",
  ];
  const TURKISH_CHAR_MAP = {
    c: /[çÇ]/g,
    g: /[ğĞ]/g,
    i: /[ıİ]/g,
    o: /[öÖ]/g,
    s: /[şŞ]/g,
    u: /[üÜ]/g,
  };
  const SIGNAL_KEYWORDS = ACCEPTED_KEYWORDS.concat(PENDING_KEYWORDS);

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function flattenText(value) {
    return normalizeText(value).replace(/\n+/g, " ").trim();
  }

  function simplifyText(value) {
    let normalized = flattenText(value).toLowerCase();
    Object.entries(TURKISH_CHAR_MAP).forEach(([replacement, pattern]) => {
      normalized = normalized.replace(pattern, replacement);
    });
    normalized = normalized
      .replace(/₺/g, " tl ")
      .replace(/[^\w\s.,]/g, " ")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return normalized;
  }

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) {
      return "";
    }
    if (digits.length === 12 && digits.startsWith("90")) {
      return digits.slice(2);
    }
    if (digits.length === 11 && digits.startsWith("0")) {
      return digits;
    }
    if (digits.length === 10 && digits.startsWith("5")) {
      return `0${digits}`;
    }
    return digits;
  }

  function normalizeAmount(value) {
    let normalized = simplifyText(value)
      .replace(/\b(?:tl|try)\b/g, " ")
      .replace(/\s+/g, "")
      .trim();
    if (!normalized) {
      return "";
    }
    const separators = normalized.match(/[.,]/g) || [];
    if (separators.length > 1) {
      const lastIndex = Math.max(normalized.lastIndexOf("."), normalized.lastIndexOf(","));
      normalized = normalized
        .split("")
        .filter((char, index) => /\d/.test(char) || index === lastIndex)
        .join("");
    }
    normalized = normalized.replace(",", ".");
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) {
      return normalized.replace(/[^\d.]/g, "");
    }
    return numeric.toFixed(2);
  }

  function normalizeAddress(value) {
    return simplifyText(value).replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeOrderId(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/[^A-Z0-9\-_]/g, "");
  }

  function detectPlatformFromUrl(url = "") {
    let hostname = "";
    try {
      hostname = new URL(String(url || "")).hostname.toLowerCase();
    } catch {
      return "Diger";
    }
    const matchesDomain = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);
    if (["getir.com", "getiryemek.com"].some(matchesDomain)) {
      return "Getir";
    }
    if (["trendyol.com", "trendyolgo.com"].some(matchesDomain)) {
      return "Trendyol Yemek";
    }
    if (["yemeksepeti.com", "yemeksepeti.com.tr"].some(matchesDomain)) {
      return "Yemeksepeti";
    }
    if (["migros.com.tr", "migros.com"].some(matchesDomain)) {
      return "Migros Yemek";
    }
    return "Diger";
  }

  function isSupportedAutoPlatform(url = "") {
    return detectPlatformFromUrl(url) !== "Diger";
  }

  function isTestAutoPage(url = "") {
    const value = String(url || "").toLowerCase();
    return value.startsWith("file://") || value.includes("localhost") || value.includes("127.0.0.1");
  }

  function isAllowedAutoWatchUrl(url = "", testMode = false) {
    return isSupportedAutoPlatform(url) || (Boolean(testMode) && isTestAutoPage(url));
  }

  function buildQuickPasteUrl(backendUrl = "") {
    return `${String(backendUrl || "").trim().replace(/\/+$/, "")}/api/restaurant/packages/quick-paste`;
  }

  function normalizeToken(value) {
    const token = String(value || "").trim();
    if (!token) {
      return "";
    }
    return token.toLowerCase().startsWith("bearer ") ? token.slice(7).trim() : token;
  }

  function shortenText(value, maxLength = 180) {
    const normalized = flattenText(value);
    if (!normalized) {
      return "";
    }
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  function buildFetchErrorDetails(details = {}) {
    const backendUrl = String(details.backendUrl || "").trim();
    const endpoint = "/api/restaurant/packages/quick-paste";
    const requestUrl = String(details.requestUrl || buildQuickPasteUrl(backendUrl));
    const token = String(details.token || "").trim();
    const status = details.status ? `status=${details.status}` : "status=yok";
    const responseBody = shortenText(details.responseBody || "", 160);
    const exceptionMessage = details.exceptionMessage || details.message || "Bilinmeyen fetch hatasi";
    const lines = [
      `backendUrl=${backendUrl || "(bos)"}`,
      `endpoint=${endpoint}`,
      `requestUrl=${requestUrl || "(bos)"}`,
      `tokenVarMi=${token ? "evet" : "hayir"}`,
      status,
    ];
    if (responseBody) {
      lines.push(`response=${responseBody}`);
    }
    lines.push("not=CORS veya network hatasi olabilir");
    lines.push(`exception=${exceptionMessage}`);
    return lines.join(" | ");
  }

  async function readResponseBodySafe(response) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  async function postToDelivera(rawText, source, sourcePlatform, dedupeKey = "", options = {}) {
    const backendUrl = String(options.backendUrl || "").trim();
    const token = normalizeToken(options.token || "");
    const requestUrl = buildQuickPasteUrl(backendUrl);
    const mode = options.mode || "manual";

    if (!backendUrl) {
      throw new Error("Backend URL gerekli");
    }
    if (!token) {
      throw new Error("Restaurant Token gerekli");
    }

    const payload = {
      source,
      sourcePlatform: sourcePlatform || "Diger",
      rawText,
      ...(dedupeKey ? { dedupeKey } : {}),
    };

    console.log(mode === "auto" ? "auto posting to RESTOMAP" : "manual posting to RESTOMAP", payload);
    console.log("post url", requestUrl);
    console.log(`${mode} backendUrl`, backendUrl);
    console.log(`${mode} token exists`, Boolean(token));

    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const responseBody = await readResponseBodySafe(response);
      let data = {};
      try {
        data = responseBody ? JSON.parse(responseBody) : {};
      } catch {
        data = {};
      }
      if (!response.ok) {
        throw new Error(buildFetchErrorDetails({
          backendUrl,
          requestUrl,
          token,
          status: response.status,
          responseBody: responseBody || data.error || "",
          exceptionMessage: `${mode}: ${data.error || `HTTP ${response.status}`}`,
        }));
      }
      console.log("post success", { mode, data });
      return data;
    } catch (error) {
      const detail = error?.message?.includes("backendUrl=")
        ? error.message
        : buildFetchErrorDetails({
            backendUrl,
            requestUrl,
            token,
            responseBody: "",
            exceptionMessage: `${mode}: ${error?.message || String(error || "")}`,
          });
      console.log("post failed", detail);
      console.log("fetch error details", detail);
      throw new Error(detail);
    }
  }

  function simpleHash(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash) + text.charCodeAt(index);
      hash |= 0;
    }
    return `h${Math.abs(hash)}`;
  }

  function uniqueLines(lines) {
    const seen = new Set();
    return lines.filter((line) => {
      const key = simplifyText(line);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function prioritizeOrderLines(lines) {
    return uniqueLines(lines)
      .filter(Boolean)
      .map((line) => {
        const simplified = simplifyText(line);
        return {
          line,
          score:
            (/05\d{2}/.test(simplified) ? 5 : 0) +
            (/(adres|mahalle|sokak|cadde|no|kat|daire|apt|bina)/.test(simplified) ? 4 : 0) +
            (/(tl|tutar|toplam|odenecek|odeme)/.test(simplified) ? 3 : 0) +
            (/(musteri|ad soyad|ad|isim|alici)/.test(simplified) ? 2 : 0) +
            (/(siparis no|order id|teslimat no|teslimat kodu|order no)/.test(simplified) ? 4 : 0),
        };
      })
      .sort((left, right) => right.score - left.score)
      .map((item) => item.line);
  }

  function findLineValue(lines, regex) {
    for (const line of lines) {
      const match = line.match(regex);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return "";
  }

  function extractPhone(text) {
    const match = text.match(/(?:\+?90\s*)?(?:0?\s*)?(5\d[\d\s()-]{8,})/);
    return normalizePhone(match?.[0] || "");
  }

  function extractAmount(text, lines) {
    const amountLine = findLineValue(
      lines,
      /(?:toplam|tutar|odenecek|odeme|payment|amount)\s*[:\-]?\s*([0-9.,\s]+(?:tl|₺)?)/i
    );
    if (amountLine) {
      return normalizeAmount(amountLine);
    }
    const inlineMatch = text.match(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:tl|₺)/i);
    return normalizeAmount(inlineMatch?.[1] || "");
  }

  function extractOrderId(text, lines) {
    const inline = findLineValue(
      lines,
      /(?:siparis no|sipariş no|order id|order no|teslimat no|teslimat kodu)\s*[:#\-]?\s*([a-z0-9\-_]+)/i
    );
    return normalizeOrderId(inline);
  }

  function extractAddress(lines) {
    const prioritized = prioritizeOrderLines(lines);
    return prioritized.find((line) => /(adres|mahalle|sokak|cadde|no|kat|daire|apt|bina)/i.test(simplifyText(line))) || "";
  }

  function extractCustomerName(lines) {
    const named = findLineValue(lines, /(?:musteri|müşteri|ad soyad|isim|ad|alici|alıcı)\s*[:\-]?\s*(.+)/i);
    if (named) {
      return flattenText(named);
    }
    return "";
  }

  function findKeyword(text, keywords) {
    const simplified = simplifyText(text);
    return keywords.find((keyword) => simplified.includes(simplifyText(keyword))) || "";
  }

  function buildAutoDedupeKey(parts) {
    const { orderId, phone, amount, address, customerName } = parts;
    const normalizedAddress = normalizeAddress(address).slice(0, 60);
    const normalizedCustomer = simplifyText(customerName).slice(0, 40);
    if (orderId) {
      return `order:${orderId}`;
    }
    if (phone && amount && normalizedAddress) {
      return `phone-amount-address:${phone}:${amount}:${normalizedAddress}`;
    }
    if (phone && normalizedAddress) {
      return `phone-address:${phone}:${normalizedAddress}`;
    }
    if (normalizedCustomer && amount && normalizedAddress) {
      return `customer-amount-address:${normalizedCustomer}:${amount}:${normalizedAddress}`;
    }
    return "";
  }

  function analyzeOrderText({ rawText = "", statusText = "", url = "" } = {}) {
    const normalizedRawText = normalizeText(rawText);
    const lines = uniqueLines(
      normalizedRawText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    );
    const prioritized = prioritizeOrderLines(lines);
    const phone = extractPhone(normalizedRawText);
    const amount = extractAmount(normalizedRawText, prioritized.concat(lines));
    const orderId = extractOrderId(normalizedRawText, prioritized.concat(lines));
    const address = extractAddress(prioritized.concat(lines));
    const customerName = extractCustomerName(prioritized.concat(lines));
    const acceptedKeyword = findKeyword(statusText, ACCEPTED_KEYWORDS) || findKeyword(normalizedRawText, ACCEPTED_KEYWORDS);
    const pendingKeyword = findKeyword(statusText, PENDING_KEYWORDS) || findKeyword(normalizedRawText, PENDING_KEYWORDS);
    const hasAcceptedSignal = Boolean(acceptedKeyword);
    const hasPendingSignal = Boolean(pendingKeyword);
    const meetsMinimumSignal =
      (Boolean(phone) && Boolean(amount)) ||
      (Boolean(phone) && Boolean(address)) ||
      (Boolean(orderId) && Boolean(amount)) ||
      (Boolean(orderId) && Boolean(address));
    const autoDedupeKey = buildAutoDedupeKey({
      orderId,
      phone,
      amount,
      address,
      customerName,
    });
    const manualDedupeKey = autoDedupeKey || `manual-hash:${simpleHash(simplifyText(normalizedRawText))}`;

    return {
      rawText: normalizedRawText,
      preview: prioritized.slice(0, 12),
      phone,
      amount,
      orderId,
      address,
      customerName,
      statusText: normalizeText(statusText),
      acceptedKeyword,
      pendingKeyword,
      hasAcceptedSignal,
      hasPendingSignal,
      supportedPlatform: isSupportedAutoPlatform(url),
      detectedPlatform: detectPlatformFromUrl(url),
      meetsMinimumSignal,
      autoDedupeKey,
      manualDedupeKey,
      canAutoSend: hasAcceptedSignal && meetsMinimumSignal && Boolean(autoDedupeKey),
    };
  }

  const api = {
    ACCEPTED_KEYWORDS,
    PENDING_KEYWORDS,
    SIGNAL_KEYWORDS,
    normalizeText,
    flattenText,
    simplifyText,
    normalizePhone,
    normalizeAmount,
    normalizeAddress,
    detectPlatformFromUrl,
    isSupportedAutoPlatform,
    isTestAutoPage,
    isAllowedAutoWatchUrl,
    buildQuickPasteUrl,
    normalizeToken,
    shortenText,
    buildFetchErrorDetails,
    postToDelivera,
    simpleHash,
    analyzeOrderText,
  };

  globalScope.DeliveraExtensionShared = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
