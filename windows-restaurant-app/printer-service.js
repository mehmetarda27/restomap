const VIRTUAL_PRINTER = /pdf|xps|onenote|fax|document writer|send to/i;
const THERMAL_PRINTER = /pos|sify|thermal|receipt|fi[sş]|58|80|xprinter|xprinter|gprinter|rongta|bixolon|citizen|star|zjiang|hprt|sunmi|rp[-_ ]?80|xp[-_ ]?\d|epson\s*tm/i;

function printerLabel(printer) {
  return String(printer?.displayName || printer?.name || "").trim();
}

function printerScore(printer) {
  const label = `${printer?.name || ""} ${printer?.displayName || ""}`;
  if (!label.trim() || VIRTUAL_PRINTER.test(label)) return -1000;
  let score = printer?.isDefault ? 25 : 0;
  if (THERMAL_PRINTER.test(label)) score += 100;
  if (/usb/i.test(label)) score += 5;
  return score;
}

function selectPrinter(printers, savedDeviceName = "") {
  const available = (Array.isArray(printers) ? printers : []).filter((printer) => printerScore(printer) > -1000);
  const saved = available.find((printer) => String(printer.name) === String(savedDeviceName));
  if (saved) return { printer: saved, source: "saved" };
  const ranked = [...available].sort((left, right) => printerScore(right) - printerScore(left));
  return ranked.length ? { printer: ranked[0], source: printerScore(ranked[0]) >= 100 ? "thermal" : "default" } : { printer: null, source: "none" };
}

function normalizePaperSize(value) {
  const paperSize = String(value || "80mm").toLowerCase();
  return ["58mm", "80mm", "a4"].includes(paperSize) ? paperSize : "80mm";
}

function applyPaperSize(html, paperSize) {
  const normalized = normalizePaperSize(paperSize);
  const page = normalized === "a4" ? "A4 portrait" : `${normalized} auto`;
  const width = normalized === "58mm" ? "54mm" : normalized === "a4" ? "190mm" : "76mm";
  const style = `<style id="restomap-desktop-paper">@page{size:${page};margin:${normalized === "a4" ? "10mm" : "0"}!important}html,body{background:#fff!important;color:#111!important}body{width:${width}!important;max-width:${width}!important;margin-left:auto!important;margin-right:auto!important}</style>`;
  const source = String(html || "");
  return source.includes("</head>") ? source.replace("</head>", `${style}</head>`) : `${style}${source}`;
}

module.exports = { applyPaperSize, normalizePaperSize, printerLabel, printerScore, selectPrinter };
