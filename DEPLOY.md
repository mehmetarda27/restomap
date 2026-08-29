# RESTOMAP Canliya Alma

## 1. Sunucu Hazirligi

Ubuntu 22.04 veya benzeri bir Linux sunucuda:

```bash
sudo apt update
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. Uygulama Dosyalari

Projeyi sunucuya kopyala, sonra `.env.example` dosyasini `.env` olarak duzenle.

Onemli alanlar:

- `NODE_ENV=production`
- `DATABASE_URL=Render Internal Database URL`
- `PUBLIC_BASE_URL=https://app.deliveraexpress.com`
- `PORT=3000` veya Render'in verdigi `PORT`
- `TRUST_PROXY=true`
- `FORCE_HTTPS=true`
- `DELIVERA_ADMIN_USERNAME`
- `DELIVERA_ADMIN_PASSWORD`
- `PGPOOL_MAX=5`
- `REDIS_URL=redis://...`
- `DELIVERA_REQUIRE_REDIS=true`
- `DELIVERA_UPLOAD_DIR=/var/data/uploads` veya harici storage path'i

Production'da SQLite kullanilmaz. `NODE_ENV=production` iken `DATABASE_URL` yoksa uygulama baslamaz.

## 2.1 Render PostgreSQL Kurulumu

1. Render Dashboard'da PostgreSQL database olustur.
2. Web Service > Environment alanina `DATABASE_URL` olarak Render'in Internal Database URL degerini ekle.
3. `NODE_ENV=production`, `DELIVERA_ADMIN_USERNAME`, `DELIVERA_ADMIN_PASSWORD`, `PUBLIC_BASE_URL`, `PORT` degerlerini ekle.
4. Render Start Command `npm start` kalabilir.
5. Deploy sonrasi loglarda su alanlari kontrol edilir:
   - `database: "postgresql"`
   - `Database pool status`
   - `Database migrations checked`
6. Shell veya one-off job ile `npm run db:migrate` calistir; ikinci calismada `applied: []` gorulmeli.
7. `/health` yanitinda `database.mode: "postgres"`, pool bilgisi, migration ozeti ve uptime gorulmeli.
8. Render Health Check Path `/ready` olmali; PostgreSQL veya zorunlu Redis hazir degilse bu endpoint `503` doner.

## 3. PM2 Ile Calistirma

```bash
cd /var/www/delivera-express
npm install
npm run db:migrate
npm run build
node smoke-test.js
pm2 start ecosystem.config.cjs
REDIS_URL=redis://127.0.0.1:6379/0 pm2 start npm --name delivera-worker -- run worker
pm2 save
pm2 startup
```

## 4. Nginx Reverse Proxy

`deploy/nginx/delivera-express.conf` dosyasini `/etc/nginx/sites-available/delivera-express` altina kopyala:

```bash
sudo ln -s /etc/nginx/sites-available/delivera-express /etc/nginx/sites-enabled/delivera-express
sudo nginx -t
sudo systemctl reload nginx
```

## 5. HTTPS Sertifikasi

Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.deliveraexpress.com
```

## 6. Kontrol Listesi

- `https://app.deliveraexpress.com/health`
- `https://app.deliveraexpress.com/ready` (`200` olmadan trafik acilmaz)
- `https://app.deliveraexpress.com/metrics`
- Admin panelinden `/api/admin/system-status`
- Admin panelinden `/api/admin/performance-summary`
- `npm run db:migrate` ikinci kez calistiginda yeni migration uygulamamali
- Admin/restoran panellerinde paket listesi varsayilan 100 kayitla acilir; `limit` maksimum 200'dur.
- Login/platform webhook/quick-paste limit asiminda `429 Too many requests` beklenir.
- Admin login
- Restoran login
- Kurye login
- Konum izni
- Platform hesabinin verification durumu
- `logs/admin-bootstrap.txt`
- `logs/password-resets.log`
- `logs/webhooks.log`

## 6.1 Production Kabul Kapisi

Canli musteriden once asagidaki maddeler tek tek dogrulanmali:

- `NODE_ENV=production` ayarli.
- `/ready` PostgreSQL ve `DELIVERA_REQUIRE_REDIS=true` iken Redis icin `200` donuyor.
- Test/simulasyon endpointleri production'da 404 donuyor.
- `.env` gercek secret manager veya hosting protected variables ile yonetiliyor.
- `DELIVERA_CORS_ORIGINS` sadece canli domainleri iceriyor.
- Reverse proxy `X-Request-Id` gonderiyor veya uygulamanin urettiği `X-Request-Id` loglarda izleniyor.
- `npm run db:migrate` iki kez calisiyor; ikinci calismada `applied: []` donuyor.
- `node smoke-test.js` temp SQLite ile basarili oluyor.
- `node scripts/load-test.js` canli DB'ye yazmadan temp SQLite ile calisiyor.
- `npm run db:backup` sonrasi PostgreSQL backup dosyasi farkli bir lokasyona kopyalaniyor.
- Restore islemi staging veya test kopyasinda prova edildi; canli DB uzerine otomatik yazmiyor.
- PM2/systemd restart sonrasi `/health` ve `/metrics` tekrar ayaga kalkiyor.
- Nginx log rotate ve uygulama `logs/` rotasyonu ayarli.
- Admin/restoran/kurye loginleri ve platform webhook secret kontrolleri elle dogrulandi.
- Acil rollback icin son calisan paket, son PostgreSQL backup ve deploy komutu kayitli.
- Upload kullaniliyorsa `DELIVERA_UPLOAD_DIR` Render persistent disk veya harici object storage uzerinde.

## 6.2 Ilk Restoran / Kurye Kurulum Akisi

1. Admin panelinde gercek restoran adi, bolge, portal kullanici adi, guclu portal sifresi ve koordinatlari gir.
2. Restoran paneline bu portal bilgisiyle giris yap ve platform Restaurant/Store/Vendor ID ile webhook secret bilgisini kaydet.
3. Platform panelinde Delivera webhook URL'sini ve secret bilgisini tanimla.
4. Ilk gercek platform siparisi geldiginde restoran panelinde webhook durumu, admin panelinde aktif siparis ve webhook logu kontrol edilir.
5. Admin panelinde gercek kurye kaydi acilir; kurye mobil panelden giris yapar, konum izni verir ve online olur.
6. Restoran siparisi onaylar; sistem tek aktif paket kuraliyla uygun kuryeye atama yapar.
7. Kurye teslim al, yola cikti ve teslim ettim akisini tamamlar; admin ve restoran panelinde durum gecmisi kontrol edilir.

## 6.3 Gunluk Operasyon Kontrol Listesi

- Gun basinda `/health` ve `/metrics` cevaplari kontrol edilir.
- Admin panelinde aktif kurye, atama bekleyen ve teslimattaki siparis sayilari incelenir.
- `npm run db:backup` ile gunluk PostgreSQL backup alinir ve uygulama disi lokasyona kopyalanir.
- Webhook loglarinda 401/403/5xx artisi var mi kontrol edilir.
- Atama bekleyen paketler ve busy/offline kurye oranlari izlenir.
- Gun sonunda kurye kapanis, nakit mutabakat ve teslim edilemeyen paketler kontrol edilir.

## 6.4 Ilk Hafta Canli Izleme

- Her gun p95 response time, 5xx sayisi ve PostgreSQL database boyutu kaydedilir.
- Ilk 100 gercek sipariste duplicate/idempotency ve restoran izolasyonu elle spot-check edilir.
- Kurye tek aktif paket kuralinin ihlal edilmedigi admin raporundan kontrol edilir.
- Platform callback retry/DLQ planinda kalan isler icin hata listesi tutulur.
- Restore proseduru canli kopya uzerinde degil, staging kopyasinda prova edilir.

## 7. Backup / Restore

Canliya almadan once ve her migration oncesi:

```bash
npm run db:backup
```

PostgreSQL backup `pg_dump --format=custom` ile `backups/delivera-postgresql-*.dump` olarak uretilir. Restore islemi mutlaka staging kopyasinda prova edilir:

```bash
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" backups/delivera-postgresql-YYYY-MM-DD.dump
```

SQLite restore scriptleri local development ve eski backup dosyalari icin korunur; production ana kaynak PostgreSQL'dir.

PostgreSQL staging restore provasi:

1. Canli DB'den `npm run db:backup` ile backup al.
2. Backup dosyasini uygulama sunucusu disinda bir lokasyona kopyala: object storage, farkli disk veya yedek sunucu.
3. Staging PostgreSQL database olustur ve `DATABASE_URL` degerini staging DB'ye cevir.
4. `pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" <backup>` calistir.
5. `npm run db:migrate`, `/health`, `/metrics` ve admin login smoke kontrolunu yap.

Cron onerisi:

```bash
15 3 * * * cd /var/www/delivera-express && /usr/bin/npm run db:backup >> logs/backup-cron.log 2>&1
```

Backup dosyalari ayni disk uzerinde tek kopya olarak birakilmamali; gunluk kopya harici diske veya S3 uyumlu object storage'a tasinmali, en az 7 gun saklanmalidir.

## 8. Migration Runner

`scripts/migrate.js`, `migrations/` klasorundeki sirali dosyalari calistirir ve `schema_migrations` tablosuna kaydeder. Migration kurallari:

- Tablo drop etmez.
- Production verisi silmez.
- Eksik tablo/kolon/index ekler.
- Ayni migration ikinci kez uygulanmaz.
- Destructive SQL `DELIVERA_ALLOW_DESTRUCTIVE_MIGRATION=1` olmadan calismaz.
- PostgreSQL migration oncesi backup alinmasi log uyarisi olarak hatirlatilir.

## 9. Metrics

Prometheus benzeri metrikler:

```bash
curl https://app.deliveraexpress.com/metrics
```

Temel sinyaller: app up, request count, error count, response time percentile, DB boyutu, tablo sayilari, queue derinligi.
Her HTTP yanitinda `X-Request-Id` header'i doner. Hata ararken bu deger proxy logu, uygulama logu ve admin performance payload'i ile birlikte takip edilir.

### 9.1 Logging / Alerting

Uygulama `services/logger.js` ile JSON structured log basar. `LOG_LEVEL=info` varsayilandir; desteklenen seviyeler `debug`, `info`, `warn`, `error`. Hata loglarinda endpoint, method, requestId ve statusCode bulunur. `401`, `403`, `429` ve `5xx` durumlari loglanir; normal 2xx/3xx trafik log spam'i azaltmak icin yazilmaz.

Canli izleme icin onerilen minimum alarm seti:

- `/health` 2 dakika ust uste basarisiz olursa critical.
- `/metrics` icinde `delivera_up 0` gorulurse critical.
- 5 dakika pencerede `delivera_errors_total` artis hizi beklenenin ustundeyse warning.
- P95 response time 2 saniyeyi 10 dakika asarsa warning.
- PostgreSQL database boyutu veya pool waiting count beklenmedik sekilde artarsa warning.
- `queueService` DLQ veya init error uretirse warning.
- Disk doluluk yuzdesi 80 ustu warning, 90 ustu critical.

Sentry/OpenTelemetry sonraki adimdir. `.env` icinde `SENTRY_DSN` ve `OTEL_EXPORTER_OTLP_ENDPOINT` secret manager uzerinden verilir. Entegrasyon yapilirken requestId trace/span attribute olarak tasinmali, platform webhook secretlari ve tokenlar redact edilmelidir. Baslangic icin HTTP request hata yakalama, worker failed job eventleri ve platform callback hatalari Sentry breadcrumb/event olarak gonderilebilir.

### 9.2 Queue / Worker

Redis yoksa uygulama inline fallback modunda calisir; webhook kabul ve saha akisi bozmaz. Redis varsa BullMQ kuyruklari `assignment.retry`, `webhook.callback.retry` ve `platform.status.sync` icin aktif olur.

```bash
npm run worker
```

Worker ayri process olarak izlenmeli. `webhook.callback.retry` maksimum 5 denemeden sonra `webhook_logs.dead_lettered_at` alanini doldurur; admin panelinde webhook hata/retry bilgisi gorunur.

## 10. Load Smoke

`npm run load:seed` ve `npm run load:test` `DATABASE_URL` varsa PostgreSQL uzerinde `load_` prefix'li idempotent test verisiyle calisir; mevcut gercek veriyi silmez. Production'da bilincli calistirmak icin `DELIVERA_ALLOW_PRODUCTION_LOAD_SEED=1` gerekir. Hafif smoke varsayilani:

- 50 restoran
- 100 kurye
- 300 paket
- concurrency 5 ve 10

## 11. Docker Compose Hazirligi

`docker-compose.yml` app, Redis ve Postgres servislerini birlikte tanimlar. `DATABASE_URL` verildiginde app PostgreSQL kullanir; `DATABASE_PATH` sadece local fallback icindir.

```bash
docker compose up -d --build
docker compose logs -f app
```

## 12. Platform Merchant Credential Dogrulama

- Trendyol Go icin sistem resmi webhook listeleme servisine istek atarak credential'i kontrol etmeyi dener.
- Diger platformlar icin opsiyonel verify URL env degiskeni girilebilir.
- Verify endpoint verilmemisse hesap `pending` kalir, ilk basarili webhook geldigi anda `verified` olur.

## 13. Veri Kaybi Yasamamak Icin

- Production ana kaynak Render PostgreSQL'dir; SQLite production'da kullanilmaz.
- Her migration ve deploy oncesi `npm run db:backup` calistir.
- Backup dosyasini Render disinda sakla ve staging restore provasi yap.
- `schema_migrations` tablosunu silme; migrationlar applied/skipped olarak izlenir.
- `DELIVERA_UPLOAD_DIR` Render persistent disk veya object storage uzerinde olmali. Ephemeral `/app/uploads` deploy/restart sonrasi kaybolabilir.
- `DELIVERA_ADMIN_PASSWORD`, platform secretlari ve `DATABASE_URL` sadece Render Environment/secret manager'da saklanmali.
