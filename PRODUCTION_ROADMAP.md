# RESTOMAP Production Roadmap

Bu plan mevcut calisan SQLite runtime'i ve `.env` dosyalarini bozmadan production seviyesine gecis icindir. Kritik kural: her buyuk adimdan sonra `npm install`, `npm run build`, `node smoke-test.js` ve kontrollu `node server.js` calistirilir.

## Aşama 1 - Production Temel

Durum: baslatildi.

- PostgreSQL: Production runtime artik `DATABASE_URL` varsa PostgreSQL kullanir. SQLite yalnizca local development fallback'tir.
- DB facade: `db/index.js` merkezi SQLite baglantisini ve `getDb/run/get/all/transaction/close` yardimcilarini saglar. PostgreSQL adapter sonraki refactor icin planli kalir.
- Migration runner: `npm run db:migrate` versiyonlu `migrations/` dosyalarini `schema_migrations` tablosuna kaydederek bir kez uygular.
- Pagination: admin/restoran/kurye bootstrap paket listeleri `limit`, `cursor`, `nextCursor`, `hasMore`, `total` metadata'si ile sinirlanir. Varsayilan limit 100, maksimum 200.
- Rate limit: login, platform order ve quick-paste icin ayri memory bucket'lar var. Redis rate-limit store sonraki production adimidir.
- Redis: Compose servisi hazir. Uygulama status payload'i `REDIS_URL` konfigurasyonunu raporlar; adapter refactor sonraki adimdir.
- Monitoring: `GET /health`, `GET /metrics`, `GET /api/admin/system-status`, `GET /api/admin/performance-summary` aktif.
- Traceability: HTTP yanitlarinda `X-Request-Id` doner; JSON payload'lar `requestId` tasir ve admin performance payload'i son istekleri gosterir.
- Backup: `npm run db:backup` veya `npm run backup:sqlite` guvenli SQLite backup alir. `npm run db:restore -- <backup>` varsayilan olarak mevcut DB uzerine yazmaz.
- PM2/nginx: `ecosystem.config.cjs` ve `deploy/nginx/delivera-express.conf` mevcut.
- Benchmark: `npm run load:seed` ve `npm run load:test` buyuk dataset senaryosu icin hazir.

Sıradaki güvenli refactorlar:

- Server bootstrap schema kodunu migration runner'a tamamen devretmeden once staging smoke ve rollback prova.
- Pagination: frontend filtrelerinin tamamini server-side search/status/date filtreleriyle birlestirme.
- Redis rate limit store: mevcut in-memory `rateBuckets` icin drop-in store.
- Background queue: assignment retry ve platform webhook callback retry islerini BullMQ worker'a tasima.
- Request log standardi: console yerine pino/winston tabanli JSON log, log rotate ve merkezi log toplama.

## Aşama 2 - Operasyon ve Ödeme Hazırlığı

- Payment provider service layer: `createPaymentIntent`, `capture`, `refund`, `handleWebhook`, `settlementPreview`.
- Provider adapter dosyalari: iyzico Marketplace, PayTR, Craftgate, banka SoftPOS. Gercek para cekimi feature flag kapali kalir.
- Webhook retry: retry count, nextAttemptAt, lastError, dead-letter tablo/queue modeli.
- Platform callback retry: accepted/preparing/assigned/delivered/rejected status bildirimleri provider adapter uzerinden kalici queue ile gonderilir.
- Canli harita: kurye location stream mevcut SSE uzerine map layer.
- Push notification: Firebase provider adapter ve notification outbox.
- Kurye optimizasyonu: yakin kurye skoru + aktif yuk + vardiya + restoran hazirlik suresi.

## Aşama 3 - Enterprise ve Büyük Ölçek

- Native mobil hazirligi: PWA manifest/service worker tamamlanir, sonra Android/iOS shell.
- Multi-tenant/white-label: tenant domain, tema, public API key, webhook subscription.
- Horizontal scaling: Redis session/rate-limit/cache, Postgres pool, queue workers, stateless app process.
- Kubernetes hazirligi: health/readiness probes, config/secrets, migration job, worker deployment.

## Migration Stratejisi

1. `npm run db:migrate` ile mevcut SQLite uzerinde `schema_migrations` olusturulur.
2. Migration dosyalari sadece `CREATE IF NOT EXISTS`, eksik kolon ekleme ve eksik index ekleme yapar.
3. Server icindeki inline schema guard simdilik korunur; tum sorgular tek seferde tasinmaz.
4. Postgres adapter `pg.Pool` ile eklenir; SQL placeholder ve tarih farklari adapter seviyesinde cozulur.
5. Read path once Postgres shadow test ile dogrulanir.
6. Controlled cutover: backup, migration export/import, smoke, load smoke, rollback plan.

## PostgreSQL Gecis Hazirligi

Bu bolum eski gecis planindan kalmistir. Guncel production davranisi: `DATABASE_URL` varsa PostgreSQL otomatik secilir; `NODE_ENV=production` ortaminda `DATABASE_URL` yoksa uygulama baslamaz. `DB_PATH` ve SQLite sadece local development fallback'tir.

Gecis adimlari:

1. Canli SQLite icin `npm run db:backup` al ve dosyayi uygulama disinda sakla.
2. Staging ortaminda `sqlite3 delivera.sqlite .dump > delivera.sql` veya esdeger export araci ile tablo/veri dump'i uret.
3. PostgreSQL import oncesi schema mapping dosyasi hazirla: `INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT`, tarih stringleri, unique indexler ve foreign key farklari tek tek eslenir.
4. Import'u staging Postgres uzerinde yap; `platform_orders` unique key, session tablolar, `webhook_logs` retry kolonlari ve audit loglar sayimla dogrulanir.
5. Shadow validation: uygulama SQLite'tan okumaya devam ederken staging araclari ayni kritik okumalari Postgres kopyasinda calistirir. Sayimlar, son 100 paket, platform order duplicate davranisi, aktif session sayilari ve admin performance payload'i karsilastirilir.
6. Cutover sadece bakim penceresinde yapilir: yeni backup, son delta export/import, `DATABASE_CLIENT=postgres` icin ayri branch, smoke test, load smoke, elle admin/restoran/kurye kontrolu.
7. Rollback: son iyi deploy image/commit'e donulur ve PostgreSQL backup staging'de restore edilerek dogrulanir. Production verisi silinmeden once reconciliation raporu alinmalidir.

SQLite export:

- Baseline: `npm run db:backup`.
- Staging export: SQLite dump veya Node tabanli tablo bazli JSON export. Canli dosya uzerinde dogrudan yazan bir islem calistirilmaz.
- Export sonrasi tablo satir sayilari ve `schema_migrations` versiyonu kaydedilir.

PostgreSQL import:

- Import staging Postgres'te denenir.
- Unique index ihlalleri duplicate/idempotency davranisi acisindan raporlanir.
- Import sonrasi `npm run db:migrate` Postgres uyumlu hale gelmeden production cutover yapilmaz.

Shadow read:

- `/health`, `/metrics`, `/api/admin/system-status`, `/api/admin/performance-summary` payload'lari SQLite ve Postgres kopyasinda karsilastirilir.
- Platform duplicate order senaryosu ayni `platform + platform_order_id + restaurant_id` icin tekrar calistirilir.
- Session/refresh token tablolari satir sayisi ve expiry alanlari kontrol edilir.

Rollback:

- Uygulama son iyi deploy config'iyle yeniden baslatilir; production ana kaynak PostgreSQL kalir.
- Son iyi SQLite backup korunur; restore otomatik overwrite olmadan prova edilir.
- Cutover sirasinda olusan yeni siparisler icin manuel reconciliation listesi hazirlanir.

## Redis Rate-Limit ve Session Plani

Rate-limit katmani `services/rateLimitStore.js` ile adapter hale getirildi. `REDIS_URL` yoksa memory store kullanilir. `REDIS_URL` varsa Redis'e baglanmayi dener; baglanti hatasinda uygulama cokmeden memory fallback'e devam eder. Login, platform order, quick-paste ve diger scope'lar ayni 429 payload formatini korur.

Session/refresh token plani:

- Kisa vadede source of truth SQLite tablolaridir.
- Redis devreye alindiginda session lookup cache olarak kullanilir; cache miss SQLite'a duser.
- Refresh token revoke/expiry islemleri once DB'ye yazilir, sonra Redis key invalidation yapilir.
- Multi-process oncesi token blacklist ve rate-limit key prefixleri tenant/role/scope bazinda netlestirilir.

## Queue / Worker / Retry / DLQ Plani

`services/queueService.js` `assignment.retry`, `webhook.callback.retry`, `platform.status.sync` job tiplerini tanimlar. `REDIS_URL` yoksa servis inline modda kalir ve mevcut timer/inline akislari calismaya devam eder. BullMQ queue olusturma hazirdir; worker runtime ayri deploy adimidir.

Retry policy:

- Varsayilan 5 deneme.
- Exponential backoff, ilk gecikme 30 saniye.
- Son denemeden sonra dead-letter olarak isaretleme.
- `webhook_logs.retry_count`, `next_retry_at`, `dead_lettered_at`, `last_error` alanlari retry/DLQ gorunurlugu icin kullanilir.

DLQ sonraki adim:

- Worker basarisiz job'u `dead_lettered_at` ile isaretler.
- Admin platform log ekraninda retry count, son hata ve yeniden dene aksiyonu gosterilir.
- Process kapaninca job kaybini onlemek icin assignment retry timer'lari BullMQ delayed job'a tasinir; bugunku inline timer fallback bir sure paralel tutulur.

## Platform Callback / Signature Plani

`services/platformSignature.js` HMAC-SHA256 placeholder dogrulama ve token fallback saglar. Gercek platform secretlari repo veya `.env.example` icine konmaz. Provider fixture hazirligi `test/fixtures/platform-webhooks/` altindadir.

Test plani:

- Her provider icin valid token fallback fixture.
- Her provider icin HMAC hex signature fixture.
- Invalid signature 401 donmeli ve `webhook_logs.signature_valid=0` yazmali.
- Duplicate order ayni transaction icinde idempotent kalmali; `platform_orders` unique key ve package duplicate guard birlikte dogrulanmali.
- Callback retry basarisiz adapter sonucunda `webhook.callback.retry` job'una hazir payload uretebilmeli.

Platform log ekran planı:

- Admin panelde provider, order id, signature sonucu, response status, retry count, next retry, dead-letter ve last error kolonlari.
- Filtreler: provider, restoran, status, tarih, dead-letter.

## Production Kullanima Gecis Checklist

Kurulum:

- `.env` dosyasi secret manager veya hosting protected variables ile uretilir; repo icine gercek secret yazilmaz.
- `NODE_ENV=production`, `DATABASE_URL`, `PUBLIC_BASE_URL`, `TRUST_PROXY`, `FORCE_HTTPS`, `DELIVERA_CORS_ORIGINS`, `DELIVERA_BACKUP_DIR`, `DELIVERA_UPLOAD_DIR`, `LOG_LEVEL` kontrol edilir.
- Domain DNS, HTTPS sertifikasi ve reverse proxy tamamlanir.
- `npm install`, `npm run build`, iki kez `npm run db:migrate`, `node smoke-test.js`, `node scripts/load-test.js` staging veya temp DB ile gecer.
- Canli DB oncesi `node scripts/backup-sqlite.js` calisir ve backup uygulama disi lokasyona kopyalanir.
- Restore sadece staging kopyasinda denenir; production overwrite otomatik yapilmaz.

Ilk operasyon:

- Admin girisi yapilir, gercek restoran kaydi acilir.
- Restoran portal bilgisiyle giris yapilir, platform Restaurant/Store/Vendor ID ve webhook secret kaydedilir.
- Platform panelindeki webhook URL/secret ayari tamamlanir.
- Ilk gercek siparisle webhook dogrulamasi, duplicate guard ve restoran izolasyonu kontrol edilir.
- Gercek kurye kaydi acilir, kurye mobil panelden online olur ve konum paylasir.
- Siparis onaylama, kurye atama, teslim al, teslim edildi ve paket gecmisi akisi uctan uca kontrol edilir.

Gunluk kontrol:

- `/health`, `/metrics`, admin system-status ve performance-summary izlenir.
- Atama bekleyen paketler, busy/offline kurye oranlari ve webhook 401/403/5xx trendi kontrol edilir.
- Gunluk backup alinip harici lokasyona kopyalanir.
- Kapanan siparisler, nakit mutabakat ve teslim edilemeyen paketler incelenir.

Ilk hafta canli izleme:

- P95 latency, 5xx, DB dosya buyumesi, webhook invalid signature, rate-limit 429 ve assignment retry sayilari gunluk kaydedilir.
- 19 restoran / 25 kurye gibi orta olcek icin yogun saatlerde admin panel gecikmesi ve SQLite write lock davranisi izlenir.
- 5k paket/gun hedefine cikmadan once worker/DLQ, Postgres shadow validation ve merkezi loglama tamamlanir.

## Smoke Test Kapısı

Her asamada su kontroller gecmeden canliya alinmaz:

- Auth: admin/restoran/kurye login, refresh, logout.
- Siparis: manuel, platform webhook, duplicate guard, restoran onay/red.
- Kurye: assignment, retry, override, status lifecycle, payment status.
- Monitoring: health, metrics, system-status, performance-summary.
- Security: rate-limit, webhook secret, secure headers.
- Migration: `npm run db:migrate` iki kez calisir; ikinci calismada yeni migration uygulamaz.
- Pagination: `/api/admin/bootstrap?limit=2&cursor=0`, `/api/restaurant/bootstrap?limit=2&cursor=0`, `/api/courier/me?limit=1&cursor=0`.
- Rate limit: login brute-force 429 `Too many requests` dondurur.
