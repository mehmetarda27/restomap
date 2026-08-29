# RESTOMAP

Mersin icin restoran, kurye ve admin operasyonunu tek omurgada toplayan multi-restaurant paket yonetim sistemi. Sistem tenant izolasyonuyla calisir; restoran sadece kendi verisini gorur, admin tum operasyonu merkezi olarak yonetir.

## Sayfalar

- [index.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/index.html)
- [restaurant.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/restaurant.html)
- [admin.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/admin.html)
- [courier.html](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/courier.html)

## Calistirma

1. VS Code terminalini ac.
2. Uygulamayi baslat:

```powershell
node server.js
```

3. Tarayicida `http://localhost:3000` ac.
4. Hizli dogrulama icin:

```powershell
node smoke-test.js
```

## Giris

- Admin varsayilan:
  `admin / Delivera123!`
- Ortam degiskenleri:
  - `DELIVERA_ADMIN_USERNAME`
  - `DELIVERA_ADMIN_PASSWORD`
- Ilk kurulumda admin env verilmezse rastgele sifre uretilir ve [logs/admin-bootstrap.txt](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/logs/admin-bootstrap.txt) dosyasina yazilir.
- Admin, restoran ve kurye login cevaplari `token` ve `refreshToken` dondurur.

## Durum Modelleri

Siparis durumlari:
- `pending`
- `awaiting_assignment`
- `assigned`
- `accepted_by_courier`
- `on_route`
- `delivered`
- `failed`
- `cancelled`

Odeme durumlari:
- `unpaid`
- `paid_online`
- `cash_expected`
- `cash_collected`
- `payment_issue`

Kurye durumlari:
- `offline`
- `online`
- `busy`

## Veri Modeli Ozeti

Ana tablolar:
- `restaurants`
- `couriers`
- `packages`
- `platform_accounts`
- `admins`
- `admin_sessions`
- `restaurant_sessions`
- `courier_sessions`
- `refresh_tokens`
- `password_reset_tokens`
- `webhook_logs`
- `audit_logs`

`packages` tablosuna eklenen operasyon alanlari:
- `source`
- `external_order_id`
- `payment_status`
- `assignment_status`
- `assigned_at`
- `accepted_at`
- `on_route_at`
- `delivered_at`
- `failed_at`
- `failure_reason`
- `last_assignment_attempt_at`
- `last_assignment_error`
- `updated_at`

`couriers` tablosuna eklenen operasyon alani:
- `status`

## Tenant Isolation

- Tum restoran bazli veriler `restaurant_id` ile filtrelenir.
- `GET /api/restaurant/bootstrap` sadece oturumdaki restoranin siparislerini ve platform hesaplarini dondurur.
- Admin tum restoranlari gorebilir, restoran baska tenant verisini goremez.

## Siparis Kaynaklari

Webhook veya entegrasyon kaynaklari:
- `platform_webhook`
- `platform_api`

Manuel dis paket:
- `external_manual`

Manuel paketler de webhook siparisleri ile ayni siparis modeli ve ayni yasam dongusu uzerinden ilerler.

## Otomatik Atama Mantigi

- Siparis olusunca otomatik atama hemen denenir.
- Sadece uygun kurye secilir:
  - `online` olmali
  - `busy` olmamali
  - aktif isi olmamali
  - ayni zone icinde olmali
  - mesafe limiti icinde olmali
- Kurye basina maksimum `1` aktif paket atanir.
- Aktif paket tanimi:
  - `assigned`
  - `accepted_by_courier`
  - `on_route`
- Uygun kurye bulunamazsa siparis `awaiting_assignment` olur.
- Son atama denemesi ve hata sebebi sipariste tutulur.

## Retry Mantigi

- Yeni siparis olusunca atama denenir.
- Kurye eklenince veya availability degisince yeniden denenir.
- Kurye is bitirince bosalan kapasite icin tekrar denenir.
- Periyodik sweep:
  - `DELIVERA_ASSIGNMENT_RETRY_MS`
  - varsayilan `15000 ms`
- Aynı anda birden fazla sweep calismasin diye koruma vardir.

## Duplicate Koruma

- Duplicate kontrolu:
  - `restaurant_id`
  - `source`
  - `external_order_id`
- Ayni siparis ikinci kez gelirse yeni kayit acilmaz.
- Webhook akisinda mevcut siparis upsert mantigi ile guncellenir.

## Manuel Paket Akisi

1. Restoran panelinden manuel paket olusturulur.
2. Veritabanina `source = external_manual` ile yazilir.
3. Aktif siparis listesine duser.
4. Otomatik atama motoruna girer.
5. Uygun kurye varsa kurye paneline duser.
6. Kurye ve admin tarafinda ayni durum/odeme yasam dongusu kullanilir.

## Admin Override Akisi

- Admin belirli siparisi belirli kuryeye atayabilir:
  - `POST /api/admin/packages/:id/override`
- Admin mevcut atamayi kaldirabilir:
  - `POST /api/admin/packages/:id/unassign`
- Admin otomatik motoru tekrar calistirabilir:
  - `POST /api/admin/packages/:id/reassign`

Override kontrolleri:
- kurye mevcut olmali
- kurye online olmali
- kurye ayni zone icinde olmali
- kurye aktif bir isi tasimiyor olmali

## Ekranlar

Restoran paneli:
- aktif siparis ozeti
- atama bekleyen siparisler
- manuel + webhook siparislerini ayni listede gorme
- atanmis kurye ve kurye durumu gorme

Admin paneli:
- genel operasyon ozeti
- aktif siparisler
- atama bekleyen siparisler
- aktif kuryeler
- son atama denemesi ve hata nedeni
- manuel override ve unassign islemleri

Kurye paneli:
- aktif gorevler
- durum guncelleme
- canli konum gonderimi

## Endpoint Ozeti

Genel:
- `GET /api/bootstrap` (yalnizca anonim landing istatistikleri)
- `GET /health`
- `GET /ready` (production PostgreSQL ve opsiyonel zorunlu Redis hazirlik kapisi)

Admin auth:
- `POST /api/admin/login`
- `POST /api/admin/refresh`
- `POST /api/admin/logout`
- `POST /api/admin/forgot-password`
- `POST /api/admin/reset-password`

Admin operasyon:
- `GET /api/admin/bootstrap`
- `POST /api/admin/restaurants`
- `POST /api/admin/couriers`
- `PATCH /api/admin/couriers/:id/availability`
- `PATCH /api/admin/packages/:id/status`
- `POST /api/admin/packages/:id/reassign`
- `POST /api/admin/packages/:id/override`
- `POST /api/admin/packages/:id/unassign`

Restoran:
- `POST /api/restaurant/session`
- `GET /api/restaurant/bootstrap`
- `POST /api/restaurant/refresh`
- `POST /api/restaurant/logout`
- `POST /api/restaurant/forgot-password`
- `POST /api/restaurant/reset-password`
- `POST /api/restaurant/platform-accounts`
- `POST /api/restaurant/packages`
- `POST /api/restaurant/packages/quick-paste`

Kurye:
- `POST /api/courier/login`
- `GET /api/courier/me`
- `POST /api/courier/refresh`
- `POST /api/courier/logout`
- `POST /api/courier/forgot-password`
- `POST /api/courier/reset-password`
- `PATCH /api/courier/location`
- `PATCH /api/courier/packages/:id/status`

Entegrasyon:
- `POST /api/webhooks/orders`
- `POST /api/webhooks/orders/cancel`
- `GET /api/webhooks/health`
- `GET /api/admin/unmatched-orders`
- `POST /api/admin/unmatched-orders/:id/match`
- `GET /api/admin/webhook-logs`
- `POST /api/admin/webhooks/test-order`
- `GET /api/restaurant/orders`
- `GET /api/restaurant/orders/:id`
- `PUT /api/restaurant/orders/:id/status`
- `POST /api/integrations/orders`
- `POST /api/platforms/trendyol-go/webhook`
- `POST /api/platforms/getiryemek/webhook`
- `POST /api/platforms/yemeksepeti/webhook`
- `POST /api/platforms/migros-yemek/webhook`

## API Firma Webhook Entegrasyonu

Webhook URL:
`POST /api/webhooks/orders`

Siparis iptal webhook URL:
`POST /api/webhooks/orders/cancel`

Gerekli header:
`x-webhook-secret`

Panel varsayilan header olarak `Authorization: Bearer {{restaurant.id}}` gonderebiliyorsa bu da kabul edilir. Bu durumda `{{restaurant.id}}`, webhook payload'indaki restoran/platform sube ID'si ile ayni olmalidir.

Content-Type:
`application/json`

Test komutu:
`npm run test:webhook`

`.env` ornegi:

```env
WEBHOOK_SECRET=
WEBHOOK_ENABLED=true
WEBHOOK_LOG_ENABLED=true
WEBHOOK_ALLOWED_IPS=
```

Restoran ekleme ekraninda Trendyol, Yemeksepeti, Getir, Migros ve ek external platform ID alanlari vardir. Gelen webhook payload'indaki `restaurantId`, `restaurant.id`, `provider.restaurantId`, `branchId` veya `storeId` degeri bu alanlarla eslestirilir. Eslesmeyen siparisler admin panelindeki "Eslestirilmeyen Siparisler" alanina duser ve manuel restorana baglanabilir.

## Guvenlik ve Operasyon

- SQLite kullanilir.
- Sifreler `scrypt` ile hashlenir.
- Refresh token rotasyonu vardir.
- Password reset tokenlari loglanir.
- Rate limit uygulanir.
- Webhook ve audit log kayitlari tutulur.
- `PUBLIC_BASE_URL`, `TRUST_PROXY`, `FORCE_HTTPS` desteklenir.
- `/health` endpointi ayakta kalma ve temel operasyon ozetini verir.

## Deploy

- [DEPLOY.md](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/DEPLOY.md)
- [OPERATIONS.md](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/OPERATIONS.md)
- [ecosystem.config.cjs](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/ecosystem.config.cjs)
- [deploy/nginx/delivera-express.conf](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/deploy/nginx/delivera-express.conf)

## Chrome Extension

- Kurulum ve kullanim: [chrome-extension/README.md](C:/Users/LENOVO/Documents/Codex/2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere/chrome-extension/README.md)
- Otomatik izleme yalnizca desteklenen platform panellerinde calisir ve sadece kabul/onay/hazirlaniyor sinyali olan siparisleri `platform_extension_auto` kaynagi ile Delivera'ya yollar.
- Extension duplicate korumasi, kaydedilen `dedupeKey` listesi ve backend duplicate cevabi ile birlikte ayni siparisi ikinci kez paketlestirmez.

## Sonraki Adimlar

- SQLite runtime'ini tam Postgres adapter'a tasiyacak kontrollu refactor
- Gercek harita/rota/ETA servisi
- SMTP veya SMS tabanli parola reset bildirimi
- Daha derin partner API verification adapter'leri
- Raporlama, alarm ve operasyon metrikleri
