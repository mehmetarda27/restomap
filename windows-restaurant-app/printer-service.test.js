const test = require("node:test");
const assert = require("node:assert/strict");
const { applyPaperSize, selectPrinter } = require("./printer-service");

test("kayıtlı yazıcı hâlâ bağlıysa onu seçer", () => {
  const printers = [
    { name: "POS-80", displayName: "POS-80", isDefault: false },
    { name: "Office", displayName: "Office", isDefault: true },
  ];
  assert.equal(selectPrinter(printers, "POS-80").printer.name, "POS-80");
  assert.equal(selectPrinter(printers, "POS-80").source, "saved");
});

test("termal yazıcıyı varsayılan ofis yazıcısından önce seçer", () => {
  const printers = [
    { name: "Office", displayName: "Office Laser", isDefault: true },
    { name: "POS-SIFY", displayName: "POS-SIFY 80mm", isDefault: false },
  ];
  assert.equal(selectPrinter(printers).printer.name, "POS-SIFY");
  assert.equal(selectPrinter(printers).source, "thermal");
});

test("sanal yazıcıları otomatik seçimden çıkarır", () => {
  const printers = [
    { name: "Microsoft Print to PDF", displayName: "Microsoft Print to PDF", isDefault: true },
    { name: "Receipt", displayName: "Thermal Receipt", isDefault: false },
  ];
  assert.equal(selectPrinter(printers).printer.name, "Receipt");
});

test("masaüstü kâğıt tercihini fiş HTML'ine uygular", () => {
  const html = applyPaperSize("<html><head></head><body>Fiş</body></html>", "58mm");
  assert.match(html, /58mm auto/);
  assert.match(html, /width:54mm/);
  assert.match(html, /background:#fff!important/);
  assert.match(html, /color:#111!important/);
  assert.match(html, /restomap-desktop-paper/);
});
