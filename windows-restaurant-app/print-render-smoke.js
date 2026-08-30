const { app, BrowserWindow } = require("electron");
const { applyPaperSize } = require("./printer-service");

async function main() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false, backgroundThrottling: false },
  });
  const html = applyPaperSize(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:18px Arial}h1{border:3px solid #111;padding:10px}</style></head><body><h1>RESTOMAP</h1><p>OTOMATİK FİŞ BASKI TESTİ</p><p>PKT-TEST-001</p></body></html>`, "80mm");
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const image = await window.webContents.capturePage();
  const bitmap = image.toBitmap();
  let darkPixels = 0;
  for (let index = 0; index < bitmap.length; index += 4) {
    if (bitmap[index] < 220 || bitmap[index + 1] < 220 || bitmap[index + 2] < 220) darkPixels += 1;
  }
  if (darkPixels < 500) throw new Error(`Fiş görüntüsü boş görünüyor: ${darkPixels} koyu piksel`);
  const pdf = await window.webContents.printToPDF({ printBackground: true, margins: { marginType: "none" } });
  if (pdf.length < 5000) throw new Error(`Fiş PDF'i beklenenden küçük: ${pdf.length} bayt`);
  process.stdout.write(`RESTOMAP baskı görüntüsü dolu: ${darkPixels} koyu piksel, ${pdf.length} bayt PDF\n`);
  window.destroy();
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  console.error(error);
  app.exit(1);
});
