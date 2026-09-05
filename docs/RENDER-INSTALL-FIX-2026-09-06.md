# Render temiz kurulum düzeltmesi

Render ekranı Dockerfile:8 `npm ci --omit=dev` aşamasında build exit 1 gösteriyordu.
Aynı package.json/package-lock.json geçici klasöre kopyalanınca hata yeniden üretildi:
`EUSAGE: Missing: @opentelemetry/api@1.9.1 from lock file`.

`npm install --package-lock-only --ignore-scripts` ile eksik transitif bağımlılık
kilit dosyasına eklendi; mevcut paket sürümleri değiştirilmedi. Docker'daki `npm ci`
korundu; doğrulamayı atlayan `npm install` veya legacy-peer-deps çözümü kullanılmadı.

Doğrulama:

- Boş geçici klasörde gerçek `npm ci --omit=dev`: başarılı, 406 paket kuruldu.
- `npm run check:install`: başarılı. Bu dry-run yerel node_modules içeriğini değiştirmez.
- Build/syntax ve deploy:preflight: başarılı.
- Son tam test: 131 toplam, 129 geçti, 0 hata, 2 eski UI testi atlandı (68436 ms).
- `deploy:check` artık önce temiz kurulum sözleşmesini dry-run ile doğrular.

Test ortamı Windows / Node 24 / npm 11; bu bilgisayarda Docker bulunmadığı için
Node 22 Alpine imajı yerelde çalıştırılmadı. Render'da yeni build sonucu ayrıca
doğrulanmalıdır. Canlı veritabanına veya Windows uygulama çalışmalarına dokunulmadı.

Ek test bulgusu: fullSystemAudit testi İstanbul gece yarısından sonra eski UTC
hakedişine İstanbul tarihi gönderiyordu. Fixture artık hakedişi teslim zamanının
UTC günüyle, restoran raporunu İstanbul günüyle doğrular. Bu, üretimdeki iki farklı
takvim sözleşmesini birleştirmez: dönem/migration kararı gerektiren açık konudur.
İlk panelPersistence çalışmasında SQLite kilidi görüldü; ayrı tekrar geçti.
