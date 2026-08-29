# RESTOMAP - Final Sistem Teknik Raporu

Rapor tarihi: 14 Mayis 2026  
Kapsam: Mevcut kod tabani, son production hazirliklari, guvenli dogrulama komutlari, test sonuclari ve kalan riskler.

## 1. Genel Sistem Özeti

RESTOMAP; restoran, kurye ve admin operasyonlarini tek panel uzerinden yonetmek icin gelistirilmis paket takip ve teslimat operasyon sistemidir. Temel problem, restoranlardan gelen siparislerin kontrollu sekilde alinmasi, onaylanmasi, uygun kuryeye atanmasi, teslim surecinin izlenmesi ve operasyon gecmisinin raporlanmasidir.

Sistemin ana kullanicilari:

- **Admin:** Restoran, kurye, aktif paket, sistem durumu, performans ve genel operasyonu izler.
- **Restoran:** Kendi siparislerini olusturur, platformdan gelen siparisleri onaylar veya reddeder, kendi paket gecmisini takip eder.
- **Kurye:** Online/offline olur, kendisine atanan aktif paketi gorur, teslim alma ve teslim etme adimlarini tamamlar.

Platform siparisleri, platform adapter katmani ve webhook endpointleri uzerinden sisteme girer. Trendyol/Getir/Yemeksepeti/Migros gibi saglayicilar icin adapter ve imza dogrulama zemini hazirlanmistir; gercek provider secretlari ve tam canli provider sozlesmeleri henuz eklenmemistir.

Kurye atama mantigi, bekleyen/onaylanan paketleri uygun kurye havuzu ile eslestirir. Tek aktif paket kurali korunur; kurye ayni anda birden fazla aktif pakete sahip olmamalidir.

Mevcut seviye **demo degil, Early Production / Pilot SaaS arasi** olarak degerlendirilmelidir. Kullanici ekranlarindaki demo/test/simulasyon goruntuleri temizlenmis, test endpointleri production modda kapatilmistir. Ancak PostgreSQL cutover, Redis session/rate-limit runtime, BullMQ worker runtime ve gercek platform HMAC entegrasyonlari tamamlanmadigi icin sistem enterprise seviye degildir.

Uygun olcek: 19 restoran / 25 kurye / gunluk 2.000 paket senaryosu icin kontrollu canli kullanim uygundur. Gunluk 5.000 paket ve anlik 50-60 siparis, ilk hafta yakin teknik izleme, gunluk backup ve hizli mudahale plani ile kullanilabilir; fakat SQLite ve tek process mimarisi nedeniyle bu senaryo ust sinira yakindir.

## 2. Mevcut Mimari

### Backend

Backend Node.js uzerinde calisir. Ana runtime dosyasi `server.js` dosyasidir. API endpointleri admin, restoran, kurye, platform webhook, health, metrics ve operasyonel durum basliklarina ayrilmistir.

Ana backend bilesenleri:

- `server.js`: HTTP server, route tanimlari, auth, operasyon endpointleri, health/metrics, platform webhook akislari.
- `shared.js`: Ortak frontend/backend yardimci mantiklari.
- `platform-adapters.js`: Platform siparislerini normalize eden adapter katmani.
- `services/logger.js`: Structured JSON log helper.
- `services/rateLimitStore.js`: Memory/Redis hazirlikli rate-limit store.
- `services/queueService.js`: Inline/BullMQ hazirlikli queue service.
- `services/platformSignature.js`: HMAC placeholder ve token comparison fallback imza dogrulama helperi.

Auth/session mantigi token tabanli calisir. Admin, restoran ve kurye rolleri ayrilmistir. Production'da test token/session uretim akislari kapali olmalidir. Mevcut sistemde localStorage token saklama kullanimi pratik ve basit olmakla birlikte XSS riskine karsi uzun vadede guclendirilmelidir.

Rate limit login, platform webhook ve quick-paste gibi kritik yuzeylerde korunur. 429 response formati korunmustur. Redis URL varsa Redis store kullanilabilecek mimari hazirlanmistir; Redis yoksa memory fallback ile sistem calismaya devam eder.

Request ID destegi korunmustur. Structured logger `info`, `warn`, `error` seviyeleri ile endpoint, method, statusCode ve requestId bilgisini loglamaya uygundur. `LOG_LEVEL` destegi `.env.example` icinde dokumante edilmistir.

### Database

Runtime varsayilan olarak SQLite'tir. Canli geciste PostgreSQL'e direkt gecis yapilmamistir; bu dogru ve guvenli karardir. Mevcut musteri/admin verisini riske atmamak icin PostgreSQL sadece adapter hazirligi ve dokumantasyon seviyesindedir.

Database bilesenleri:

- `db/index.js`: SQLite runtime korunarak `DATABASE_CLIENT=sqlite|postgres` adapter hazirligina acilmistir.
- `migrations/`: Veritabani migration dosyalari.
- `scripts/migrate.js`: Migration runner; `schema_migrations` ile uygulanmis migrationlari takip eder.
- `scripts/backup-sqlite.js`: SQLite backup alir.
- `scripts/restore-sqlite.js`: Restore icin kontrollu arac.

`schema_migrations` tablosu migration tekrarlarini engeller. Son dogrulamada migration runner mevcut migrationlari tekrar uygulamamis, skipped olarak gecmistir. Bu idempotency acisindan olumludur.

Indexler operasyonel sorgular icin eklenmistir. Ozellikle aktif paket, restoran izolasyonu, platform duplicate kontrolu ve tarih siralamali gecmis sorgulari icin indexler performans acisindan kritiktir.

PostgreSQL'e henuz gecilmemesinin nedeni: canli veriyi koruma, export/import provasi, shadow validation ve rollback plani tamamlanmadan direkt cutover yapmanin riskli olmasidir.

### Frontend

Frontend dosyalari statik HTML/JS/CSS yapisindadir:

- `admin.html`, `admin.js`: Admin operasyon paneli.
- `restaurant.html`, `restaurant.js`: Restoran paneli.
- `courier.html`, `courier.js`: Kurye mobil agirlikli panel.
- `styles.css`: Ortak tema ve layout.

Admin paneli restoran/kurye yonetimi, aktif siparisler, sistem durumu, performans ve operasyon gozlemi icindir. Restoran paneli siparis olusturma, platform siparis onay/red, kendi paketlerini izleme ve gecmis listeleme icindir. Kurye paneli online/offline, aktif paket, teslim alma/teslim etme ve harita linkleri icindir.

Pagination siparis ve gecmis listelerinde desteklenir. Mobil gorunum ozellikle kurye panelinde korunmustur. Demo/test butonlari ve kullaniciya gorunen simulasyon ifadeleri production yuzeyinden temizlenmistir.

### Monitoring

Monitoring yuzeyleri:

- `GET /health`: Uygulama, database, operasyon ve queue/cache durumunu dondurur.
- `GET /metrics`: Prometheus benzeri metrik ciktisi verir.
- `GET /api/admin/system-status`: Admin auth ile sistem durumunu verir.
- `GET /api/admin/performance-summary`: Admin auth ile performans ozetini verir.

Request ID loglara ve response takiplerine eklenebilir durumdadir. Structured logging mevcut fakat merkezi log toplama, Sentry veya OpenTelemetry henuz entegre degildir.

### Production Safe Mode

Production modda test/simulasyon endpointleri kapali olacak sekilde guvenlik hazirligi yapilmistir. Demo/test butonlari kullanici yuzeyinden kaldirilmistir. Smoke/load testler temp SQLite ile calisacak sekilde duzenlenmistir. `.env` dosyasina dokunulmamali, gercek secretlar `.env.example` icinde yer almamalidir.

## 3. Yapılan Büyük Geliştirmeler

### Güvenlik

- CORS production ayari dokumante edildi.
- Login/platform/quick-paste rate-limit korundu.
- 429 response formati korunarak adapter mimarisi hazirlandi.
- Admin/restoran/kurye auth kontrolleri guclendirildi.
- Production safe mode ile test/simulasyon yuzeyleri kapatildi.
- Secret/env sızıntısını azaltmak icin hata mesajlari sade tutuldu.
- `.env.example` gercek secret icermeyecek sekilde production notlariyla guncellendi.

### Performans

- Pagination ile buyuk listelerde gereksiz tam veri yukleme azaltilmistir.
- Indexler ile aktif paket, gecmis, duplicate ve platform sorgulari hizlandirilmistir.
- Assignment akisi tek aktif paket kuralini koruyacak sekilde optimize edilmistir.
- Platform webhook duplicate kontrolu korunmustur.
- Admin performans ozetleri ile operasyonel izleme zemini eklenmistir.

### Test

- Smoke test temp SQLite kullanir ve canli DB'ye yazmamasi hedeflenmistir.
- Load test temp SQLite kullanir; production DB'ye test verisi yazmaz.
- Duplicate order, platform webhook, restaurant approval, courier assignment ve tek aktif paket kurali test edilir.
- Test sonunda temp DB ve gecici log izleri temizlenmelidir.

### DevOps

- Dockerfile ve docker-compose hazirligi mevcuttur.
- `DEPLOY.md` production kurulum, backup, restore, health/metrics ve alerting notlarini icerir.
- Backup/restore scriptleri bulunur.
- Roadmap dokumani PostgreSQL, Redis, BullMQ, platform callback ve monitoring adimlarini tarif eder.

### Production Hazırlığı

- PostgreSQL adapter placeholder ve `DATABASE_CLIENT` mantigi hazirlandi.
- Redis rate-limit store hazirligi eklendi; memory fallback korunur.
- BullMQ/queue service hazirligi eklendi; Redis yoksa inline mod calisir.
- Platform signature helper eklendi.
- Structured logger eklendi.
- Request ID akisi korunur.

### Demo Temizliği

- Demo/test siparis uretme butonlari kullanici yuzeyinden kaldirildi veya production'da gizlendi.
- Fake callback davranislari production yuzeyinden uzaklastirildi.
- Production'da test endpointlerinin 404 donmesi hedeflendi.
- Kullanici ekranlarindaki demo/simulasyon goruntusu temizlendi.

## 4. Test ve Kapasite Sonuçları

### Bu rapor öncesi çalıştırılan komutlar

| Komut | Sonuc |
| --- | --- |
| `npm install` | Basarili, paketler guncel, 0 vulnerability |
| `npm run build` | Basarili, Node syntax kontrolleri gecti |
| `npm run db:migrate` | Basarili, yeni migration uygulanmadi |
| Ikinci `npm run db:migrate` | Basarili, idempotent |
| `node smoke-test.js` | Basarili, temp SQLite ile calisti |
| `node scripts/backup-sqlite.js` | Basarili, yeni backup olustu |
| `node scripts/load-test.js` | Basarili, temp SQLite ile calisti |
| `node server.js` | Kisa sureli baslatildi, `/health` ve `/metrics` kontrol edildi |
| `GET /health` | 200, SQLite mode, queue inline, rate-limit memory |
| `GET /metrics` | 200, metrics ciktisi alindi |
| `GET /api/admin/system-status` | Load test temp server uzerinden admin auth ile 200 senaryolari gecti |
| `GET /api/admin/performance-summary` | Load test temp server uzerinden admin auth ile 200 senaryolari gecti |
| `npm test` | `npm test` scripti yok |
| `docker compose config` | Docker CLI yok; dogrulanamadi |

### Load Test

Bu turda calisan load test temp SQLite uzerinde calismistir. Canli `delivera.sqlite` dosyasina test verisi yazilmamistir.

Guncel test dataseti:

- 100 restoran
- 120 kurye
- 300 baslangic paket
- 240 baslangic platform order
- Test sonunda 316 paket ve 256 platform order

Guncel test sonuclari:

| Senaryo | Istek | Sure | Ortalama | P95 | Hata |
| --- | ---: | ---: | ---: | ---: | ---: |
| system-status-5 | 5 | 20 ms | 16.2 ms | 17 ms | 0 |
| platform-order-5 | 5 | 100 ms | 57 ms | 96 ms | 0 |
| system-status-10 | 10 | 38 ms | 21 ms | 34 ms | 0 |
| platform-order-10 | 10 | 180 ms | 113.9 ms | 177 ms | 0 |
| 50-couriers-online | 50 | 266 ms | 142.06 ms | 250 ms | 0 |
| 100-couriers-online | 100 | 422 ms | 203.09 ms | 386 ms | 0 |
| 50-restaurants-approve | 50 | 839 ms | 429.7 ms | 794 ms | 0 |
| 100-restaurants-approve | 100 | 2369 ms | 1042.18 ms | 2241 ms | 0 |
| admin-heavy-bootstrap-10 | 10 | 148 ms | 86.1 ms | 147 ms | 0 |

Server performans ozeti:

- Toplam request: 343
- Error count: 0
- Ortalama response: 12.38 ms
- Max response: 49 ms
- P95: 35 ms
- P99: 43 ms
- Queue mode: inline
- Rate-limit store: memory

Kullanici talebinde gecen 100 restoran / 1000 kurye / 100k+ siparis / 80k+ platform order ve 50 / 100 / 250 / 500 concurrency sonuclari icin bu turda dogrudan yeniden uretilmis tam cikti yoktur. Mevcut kod ve onceki kapasite degerlendirmesine gore 50-100 concurrency SQLite/tek process icin makul sinirdir. 250 concurrency sonrasinda write lock, timeout ve event-loop baskisi riski artar. 500 concurrency icin PostgreSQL, Redis rate-limit/session, BullMQ worker ve merkezi monitoring tamamlanmadan canli oneri verilmez.

### Gerçek Hedef Senaryo

Hedef:

- 19 restoran
- 25 kurye
- Normal gun 2.000 paket
- Yogun gun 5.000 paket
- Anlik maksimum 50-60 siparis

Degerlendirme:

- **Normal gun 2.000 paket:** Uygun. Backup, health/metrics izleme ve ilk hafta teknik destek ile canliya alinabilir.
- **Yogun gun 5.000 paket:** Kullanilabilir ancak ust sinira yakindir. Ozellikle ayni anda cok sayida yazma, restaurant approval ve courier state update anlarinda SQLite lock riski izlenmelidir.
- **Anlik 50-60 siparis:** Mevcut testlerde 50 concurrency sinifi basarili gorunmektedir. 60 siparis burst icin kisa sureli piklerde kabul edilebilir; uzun sureli veya surekli 100+ concurrency icin PostgreSQL ve queue gecisi onerilir.

### Smoke Test

Smoke testte dogrulanan ana akislar:

- Admin, restoran ve kurye login akislari
- Platform order webhook
- Quick paste akisi
- Duplicate order engeli
- Restaurant approval
- Courier assignment
- Tek aktif paket kurali
- Health/metrics
- Backup scripti

## 5. Mevcut Production Seviyesi

Karar: **Early Production**

Neden:

- Demo/test goruntuleri production yuzeyinden temizlenmis durumda.
- Gercek restoran, kurye ve siparis operasyonlari icin temel akislar mevcut.
- Auth, rate-limit, backup, health, metrics, pagination ve production safe mode bulunuyor.
- SQLite runtime, memory rate-limit/session, inline queue ve eksik gercek platform HMAC entegrasyonlari enterprise seviyeyi engelliyor.

Demo goruntusu: Kullanici panellerinde bilincli demo/test/simulasyon goruntusu kalmamasi hedeflenmis ve buyuk oranda saglanmistir. Gelistirici test scriptleri repo icinde kalabilir.

Gercek musteri kullanimi: Kucuk/orta operasyon icin uygun. Yuksek concurrency, coklu sube zinciri, SLA'li enterprise musteri ve coklu process deployment icin henuz eksikler vardir.

## 6. Kalan Riskler

- **SQLite runtime siniri:** Yuksek eszamanli yazmalarda lock ve timeout riski vardir.
- **Tek process darboğazı:** Coklu CPU/worker kullaniminda session, queue ve rate-limit state'i merkezi degildir.
- **PostgreSQL cutover yapilmadi:** Adapter ve plan var; export/import, shadow validation ve rollback provasi tamamlanmadan gecilmemeli.
- **Redis/BullMQ runtime eksik:** Hazirlik var, fakat canli persistent job queue henuz aktif degil.
- **Gercek platform entegrasyonlari eksik:** Provider bazli HMAC/callback sozlesmeleri, fixture testleri ve canli secret yonetimi tamamlanmali.
- **Merkezi log/alerting eksik:** Structured log var, fakat Sentry/OpenTelemetry/ELK/Loki gibi merkezi sistem yok.
- **Monitoring/alerting eksikleri:** Enterprise musteri icin uptime monitor, error alert, queue lag ve DB lock alarmi eklenmeli.
- **LocalStorage token riski:** XSS durumunda token sızıntısı olabilir; HttpOnly secure cookie veya daha guclu session modeli degerlendirilmeli.
- **Docker doğrulaması yapılamadı:** Docker CLI sistemde bulunmadigi icin `docker compose config` dogrulanamadi.

## 7. Canlıya Alma Şartları

19 restoran / 25 kurye / gunluk 2k-5k paket senaryosu icin canliya almadan once:

- Gunluk otomatik SQLite backup aktif edilmeli.
- Ilk hafta canli log ve health/metrics izlenmeli.
- Domain ve HTTPS tamamlanmali.
- CORS production domainlerine sinirlanmali.
- Admin/restoran/kurye gercek hesaplari kontrollu acilmali.
- Production modda test endpointlerinin kapali oldugu dogrulanmali.
- Restore provasi staging kopyasinda yapilmali.
- En az 2 vCPU, 4 GB RAM, SSD disk ve duzenli disk monitoring onerilir.
- Ilk hafta manuel teknik destek ve gunluk operasyon kontrol listesi uygulanmali.
- Backup dosyalari production DB ile ayni disk uzerinde tek kopya olarak birakilmamali; harici yedek hedefi eklenmeli.

## 8. Sonraki Kritik Geliştirmeler

| Oncelik | Gelistirme | Neden gerekli? | Yapilmazsa risk | Zorluk | Test yontemi |
| ---: | --- | --- | --- | --- | --- |
| 1 | BullMQ worker + gercek retry/DLQ staging | Assignment retry, webhook callback retry ve platform sync isleri process restart sonrasi kaybolmamalidir | Job kaybi, tekrar denenmeyen callback, manuel operasyon yuklenmesi | Orta | Redis staging, process kill/restart, retry ve DLQ fixture testleri |
| 2 | PostgreSQL adapter + export/import + shadow validation | SQLite write concurrency sinirini asmak icin | Yogun gunde DB lock ve timeout | Orta/Yuksek | SQLite export, Postgres import, read shadow compare, rollback provasi |
| 3 | Redis session/rate-limit store production | Coklu process ve restart dayanikliligi icin | Memory state kaybi, rate-limit bypass, session tutarsizligi | Orta | Redis kesinti/fallback testi, multi-process login/rate-limit testi |
| 4 | Gercek platform callback/HMAC entegrasyonlari | Provider webhook guvenligi ve uyumlulugu icin | Sahte callback, duplicate veya imza uyumsuzlugu | Orta | Provider fixture, invalid signature, replay ve duplicate testleri |
| 5 | Merkezi log/Sentry/OpenTelemetry + alerting | Canli hatalari hizli yakalamak icin | Hata gec fark edilir, SLA riski | Orta | Error injection, alert route, trace/requestId korelasyon testi |
| 6 | Restore provasi + backup cron | Backup'in gercekten donulebilir oldugunu kanitlamak icin | Backup var ama restore edilemez olabilir | Dusuk/Orta | Staging restore, checksum, smoke test |
| 7 | Role/permission guclendirme | Admin/restoran/kurye yetki sinirlarini sertlestirmek icin | Yetki asimi, veri izolasyon hatasi | Orta | Role matrix API testleri, negative auth testleri |
| 8 | Canli kurye haritasi / saha UX iyilestirme | Operasyon ekibinin saha gorunurlugunu artirmak icin | Manuel takip, gecikme fark edilememe | Orta | Mobil saha testi, location permission, harita performans testi |

## 9. Dosya Bazlı Özet

- `server.js`: Ana Node.js server; API route'lari, auth, operasyon akislarini, health/metrics ve platform webhooklarini barindirir.
- `db/index.js`: Database adapter katmani; SQLite runtime ve PostgreSQL placeholder hazirligi.
- `migrations/`: Database sema evrimini tutan migration dosyalari.
- `scripts/migrate.js`: Migration runner; `schema_migrations` ile idempotent migration uygular.
- `scripts/load-test.js`: Temp SQLite uzerinde load/kapsam testi calistirir.
- `scripts/backup-sqlite.js`: SQLite backup olusturur.
- `scripts/restore-sqlite.js`: Backup'tan restore icin kontrollu script.
- `services/logger.js`: JSON structured log helper; `info`, `warn`, `error` seviyeleri.
- `services/rateLimitStore.js`: Memory default, Redis hazirlikli rate-limit store.
- `services/queueService.js`: Inline default, BullMQ hazirlikli queue service; job tipleri tanimli.
- `services/platformSignature.js`: Platform webhook imza dogrulama helperi.
- `platform-adapters.js`: Provider payloadlarini normalize eden adapter katmani.
- `admin.js`: Admin panel frontend mantigi.
- `restaurant.js`: Restoran panel frontend mantigi.
- `courier.js`: Kurye panel frontend mantigi.
- `DEPLOY.md`: Production kurulum, izleme, backup/restore ve alerting notlari.
- `PRODUCTION_ROADMAP.md`: PostgreSQL, Redis, queue, callback ve monitoring roadmap'i.
- `.env.example`: Production ayarlari icin placeholder ve aciklamalar; gercek secret icermez.
- `Dockerfile`: Node.js container imaji icin temel tarif.
- `docker-compose.yml`: Compose deployment hazirligi; bu ortamda Docker CLI olmadigi icin dogrulanamadi.

## 10. Son Karar

### Sonuç

RESTOMAP mevcut haliyle **Early Production** seviyesindedir. Demo/pilot goruntusunden cikarilmis, gercek restoran/kurye/siparis operasyonu icin temel akislar hazirlanmistir. Ancak enterprise olcek icin PostgreSQL, Redis, BullMQ worker, gercek provider signature entegrasyonlari ve merkezi observability tamamlanmalidir.

### Kullanılabilirlik

19 restoran / 25 kurye / yogun gun 5k paket icin **kontrollu canli kullanim mumkundur**. Normal 2k paket/gun senaryosu icin daha guvenlidir. 5k gunlerde sistem yakin izlenmeli, backup ve teknik destek hazir tutulmalidir.

### Büyük Müşteri

Buyuk musteri icin eksikler:

- PostgreSQL cutover
- Redis session/rate-limit
- BullMQ persistent worker ve DLQ
- Gercek platform HMAC/callback sertlestirmesi
- Merkezi log, alerting ve tracing
- Restore provasi ve otomatik backup cron
- Daha detayli role/permission modeli

### Tavsiye

Kucuk/orta operasyon icin sahaya kontrollu cikilabilir. Canliya cikmadan once son pratik adimlar: production domain/HTTPS/CORS ayari, gercek hesap kurulumu, production'da test endpoint kapali dogrulamasi, gunluk backup kurulumu, staging restore provasi ve ilk hafta aktif teknik izleme.

Buyuk veya SLA'li musteri icin once BullMQ worker + DLQ staging, PostgreSQL shadow validation ve Redis session/rate-limit production gecisi tamamlanmalidir.

