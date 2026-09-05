# RESTOMAP son stabilizasyon denetimi — 5 Eylül 2026

## Sonuç ve kapsam

Başlangıç: `bfded6284161f2355950220e060fee8e8f315bb2`. Bu çalışma yeni modül geliştirmesi değil; mevcut davranışın denetimi ve doğrulanan hataların düzeltmesidir. Canlı veritabanına test verisi yazılmadı. Testler geçici SQLite veritabanları ve localhost üzerinde çalıştı. PostgreSQL/Render/gerçek telefon doğrulaması yerine geçmez.

| Alan | Sonuç | Kanıt ve sınır |
|---|---|---|
| Admin | PARTIAL | 47 menü tarayıcıda açıldı; mevcut CRUD testleri geçti. Her menünün her düğmesi uçtan uca test edilmedi. |
| Kurye | PARTIAL | Gerçek API ile kabul/yola çık/teslim/hakediş ve tarayıcı açılışı; fiziksel cihaz GPS/push yok. |
| Restoran | PARTIAL | Gerçek API ile oluşturma, koordinat onayı, rapor ve yabancı kullanıcı izolasyonu; tüm POS donanımları yok. |
| Backend | PASS (test kapsamı) | Ana takım ve ayrı smoke; bütün olası girdilerin kanıtı değildir. |
| Database | PARTIAL | SQLite bütünlük/FK/migration testleri; canlı PostgreSQL concurrency denenmedi. |
| Finance | PARTIAL | Kuruş, journal, düzeltme, kontör ve ödenmiş dönem testleri; bütün modüller ortak journal'a bağlı değil. |
| Notifications | PARTIAL | Kalıcı kayıt, doğru alıcı, toplam okunmamış ve SSE testi; gerçek OS push credential sınırı var. |
| Reports | PARTIAL | 10=7+2+1 ve tarih/gece yarısı testleri; bootstrap verisinden hesaplanan eski raporlar büyük veri için ayrıca ele alınmalı. |
| Realtime | PARTIAL | Gerçek SSE rol izolasyonu ve kopuş sonrası kalıcı kayıt okunması; uzun süreli ağ kesintisi/çok sunucu testi yok. |
| Authorization | PASS (test kapsamı) | Yönetici uçları reddediyor; başka kurye/restoran okuma ve yazmaları izole. Tam penetrasyon testi değildir. |

## A) Başlangıçta bulunan hatalar

| Önem | Hata | Yeniden üretim |
|---|---|---|
| HIGH | Ödenmiş hakediş admin notuyla yeniden hesaplanabiliyordu. | paid kayda PATCH bonus=900 ve adminNote. |
| HIGH | Kurye duyurusu restoran bootstrap yanıtına karışıyordu. | courier duyurusu oluştur, restoran bootstrap oku. |
| MEDIUM | Rol duyuruları ilgili kullanıcıların kalıcı bildirimlerine düşmüyordu. | courier duyurusu sonrası notification_logs kontrolü. |
| MEDIUM | Hatalı ids tipi bütün bildirimleri okundu yapabiliyordu. | ids alanına dizi yerine string gönder. |
| MEDIUM | Okunmamış sayaç yalnız son 20/50 kaydı sayıyordu. | 35 okunmamış kaydı olan kurye. |
| MEDIUM | Admin tarih aralığı toplamı iptalleri ikinci kez ekliyordu. | totalOrders iptalleri zaten içerirken UI ekleme yapıyordu. |
| MEDIUM | Tekrarlanan ödendi isteği ilk ödeme tarihini/notunu değiştiriyordu. | Aynı hakedişe iki mark-paid isteği. |
| LOW | Eski smoke verisi doğrulanmamış teslimat adresiyle yola çıkmayı bekliyordu. | Ayrı smoke 422 ile durdu; üretimdeki adres doğrulaması doğru çalışıyordu. |

## B) Düzeltilen hatalar

- Ödenmiş hakediş PATCH için 409; tekrar üretim mevcut kaydı korur. Tekrar ödeme aynı kaydı döndürür, tarih/notu değiştirmez. Geçersiz ödeme tarihi 400 olur.
- Duyuru okuması role göre sınırlandı; `all` duyuruları ilgili rollerde görünür. Alıcı seçimi push ile aynı yardımcıyı kullanır; kalıcı bildirimler gerçek alıcılara yazılır. Rol duyurusu SSE filtresine eklendi.
- ids doğrulaması: dizi, en fazla 500, boş olmayan string. Bozuk istek veri değiştirmeden 400. Boş dizi/eksik ids mevcut tümünü-okundu sözleşmesini korur.
- Sunucu toplam okunmamış sayısını döndürür; üç panel sayaç ve tümünü-okundu butonu bunu kullanır.
- Admin toplamı backend totalOrders alanını doğrudan gösterir.
- Smoke fixture, beş yola çıkış öncesinde gerçek restoran delivery-point API'siyle belirli test koordinatını onaylar. Üretim adres kontrolü kaldırılmadı.

## C) Eklenen regression testleri

`test/fullSystemAudit.test.js`: 11 alt test + üst test (Node toplamı 12).

1. Gerçek SSE kurye duyurusunu alır, restoran alamaz; stream kapanınca workspace kalıcı bildirimi döndürür. Bu kontrol Last-Event-ID replay garantisi değildir.
2. Sayfa dışı okunmamış kayıtların sayılması.
3. Bozuk seçili-okundu isteğinin tümünü okumaması.
4. Tek kayıt/tüm kayıt/idempotent okuma ve başka alıcı izolasyonu.
5. Kurye duyurusunun iki kuryeye yazılması, restorana yazılmaması/görünmemesi.
6. Kurye/restoran oturumlarının admin uçlarından reddi.
7. Sorgu parametresindeki yabancı kimliklerin self-scope okumayı değiştirmemesi.
8. Ödenmiş hakedişin notla değiştirilememesi ve tekrar ödeme değişmezliği.
9. SQLite integrity_check ve foreign_key_check.
10. Restoran siparişi → gerçek otomatik atama → kabul → doğrulanmış nokta → yola çık → teslim → 10,30 TL hakediş → restoran raporu; yabancı kurye durum ve yabancı restoran nokta değişikliği reddi.
11. Admin aralık/restoran günlük raporunda 10 sipariş = 7 teslim + 2 iptal + 1 aktif; diğer restoran sıfır görür.

`adminDesignWorkflow.test.js` içindeki toplam beklentisi 4'ten 3'e düzeltildi: fixture totalOrders=3, cancelledCount=1 zaten toplamın içindedir. Yanlış iş kuralını korumak için üretim hesabı değiştirilmedi.

## D) Değiştirilen dosyalar

- server.js
- admin-design-bridge.js
- restaurant-design-bridge.js
- courier-design-bridge.js
- test/adminDesignWorkflow.test.js
- test/fullSystemAudit.test.js
- test/helpers/auditFixture.js
- smoke-test.js
- Bu rapor.

## E) Migrationlar

Yeni migration veya canlı veri dönüşümü yok. Mevcut migrationlar geçici DB başlangıcında ve smoke migration/backup kontrolünde çalıştı. Finansal journal migration tekrar çalıştırma testi mevcut takımda geçti. Canlı PostgreSQL migration yürütülmedi.

## F) Güvenlik düzeltmeleri

Kurye duyurusunun restoran rolüne sızması kapatıldı. Testler başka kullanıcı notification ID'si, courier ID'si, restaurant ID'si, paket durumu ve teslimat noktası üzerinden izolasyonu kontrol ediyor. Self-scoped GET uçları yabancı filtreyi yok sayıp kendi verisini döndürüyor; 200 tek başına veri sızıntısı değildir. Admin uçları yetkisiz oturumları reddeder. Tam endpoint envanteri için ayrı kapsamlı penetrasyon testi hâlâ gerekli.

## G) Finans düzeltmeleri

Ödenmiş dönem geçmişi değişmez. Mevcut adminManagementCrud testi -500 → -200 → başka tarih → sil → paid dönem reddi senaryolarını ve kontör 0+10-3=7 hesabını doğruladı. financialJournal testleri ondalık hassasiyet, negatif değer, geçersiz tutar, aynı event tekrar/çatışma, FK rollback, dengeli satırlar ve ters kayıt testlerini kapsar. Journal servisinin geçmesi bütün mevcut tahsilat/iade uçlarının bu servisi kullandığı anlamına gelmez.

## H) Bildirim düzeltmeleri

Rol bazlı duyuru kalıcı kaydı/SSE ve okunmamış toplamı düzeltildi. Mevcut push testleri invalid token, retry, logout sırasında retry iptali, deep-link ve görünür panel/OS çift bildirim bastırmasını kapsar. Gerçek cihaz teslim başarısı iddia edilmiyor. Push dış servisinin çökmesi için mevcut transport unit testleri var; üretimde servis kesintisi yaratılmadı.

## I) Rapor düzeltmeleri

Admin iptal çift sayımı kaldırıldı. Günlük rapor testleri İstanbul gece yarısı ve filtreleri; yeni test gerçek DB'den 10/7/2/1 dağılımını kontrol eder. Restoran endpointi günlük/haftalık, admin endpointi ayrıca tarih aralığı destekler; testler bu sözleşmeye göre çalışır. Eski bootstrap-limitli raporlar için tam veri hacmi garantisi verilmez.

## J) Panel entegrasyonu ve 47 menü

Gerçek Chromium, geçici sunucu ve admin oturumu kullanıldı. Aşağıdaki 47 route açıldı; route turunda HTTP >=400 kaydı yoktu. Bu bir **açılış/boş durum taramasıdır**, 47 modülün tüm CRUD ve mali etkilerinin onayı değildir. Harita DOM'unu test koduyla zorla silince alınan Leaflet hatası gerçek kapatma düğmesiyle tekrar üretilemedi; üretim hatası diye değiştirilmedi.

| # | Menü | İncelenen bağlantı / kalan sınır |
|---|---|---|
|1|Operasyon|Paket listesi; ana akış API testli|
|2|Operasyon Haritası|Harita modalı; fiziksel GPS yok|
|3|Siparişler|Detaylı sipariş raporu|
|4|İşletmeler|Liste ve konum yönetimi|
|5|Canlı Harita|Kurye haritası; rol scope mevcut testli|
|6|Oto Atama Yönetimi|Sayaç/yeniden dengeleme; atama API testli|
|7|Kuryeler|CRUD/durum ekranı|
|8|Kurye Raporu|Durum raporu|
|9|Haftalık İzin Planı|Kalıcı yönetim kaydı; tam operasyon etkisi ayrıca doğrulanmalı|
|10|Kurye Vardiya & Mola|Plan formu; mevcut yönetim testi|
|11|Kurye Ceza & Ödül Kaydı|Hakedişle ilişkili CRUD regression testli|
|12|Ödeme Değişiklikleri|Kayıt ekranı; mali düzeltme motoru değildir|
|13|Kurye Performans|Tarih filtreli rapor|
|14|Kurye Tahsilat|Nakit mutabakat ekranı|
|15|Kurye Nakitleri|Nakit özeti|
|16|İşletme-Kurye Teslim Takibi|Teslim raporu|
|17|Kurye Ücretlendirme|Paket başı ücret formu|
|18|Kurye Kazanç|Hakediş üret/ödendi; paid kilidi testli|
|19|Restoran Bazlı Kurye Kazanç|Rapor; hacim sınırı ayrıca test edilmeli|
|20|Kurye Havuz Yetkileri|Uygunluk raporu; özel izin CRUD değildir|
|21|Havuz Sipariş Geçmişi|Geçmiş raporu|
|22|Günlük Sipariş Raporu|Backend hesap raporu|
|23|İşletme Tarih Aralığı|Backend aralık raporu|
|24|Detaylı Sipariş Raporu|3 ile ortak rapor; ayrı işlev diye sunulmamalı|
|25|Parçalı Ödeme Raporu|Mevcut ödeme raporu|
|26|Kurye Teslim Süre Raporu|Teslim süreleri|
|27|Kurye Ödeme Türü Raporu|Ödeme kırılımı|
|28|Kurye Ceza & Ödül Raporu|Yönetim kayıtları raporu|
|29|Firma Kazanç|Kazanç görünümü; mali mutabakat bütünü onaylanmadı|
|30|İşletme Tahsilat|Settlement ekranı; gerçek para transferi değildir|
|31|Restoran Hesap Raporu|Backend rapor; çift sayım düzeltildi|
|32|İşletme Ücret İadesi|Kayıt; gerçek iade/ters kayıt motoru değil — NEEDS DECISION|
|33|Entegrasyon Yönetimi|Hesap/bağlantı testi; gerçek sağlayıcı testi yok|
|34|Restoran Giriş Bilgileri|Hesap bilgisi ekranı|
|35|Eşleşmeyen Paketler|Özel workspace; mevcut ingress testleri|
|36|Restoran Cihaz Kurulumu|CMD indirildi, çalıştırılmadı|
|37|Kurye Özel Ücretlendirme|Kayıt; fiyat motoruna etkisi onaylanmadı|
|38|İşletme Ücretlendirme|Kayıt; fiyat motoruna etkisi onaylanmadı|
|39|Restoran Fiyatlandırması|Kayıt; fiyat motoruna etkisi onaylanmadı|
|40|Paket Satın Alma|Kontör hareketi; ödeme sağlayıcısı satın alması değil|
|41|Sistem Dışı Onaylar|Kayıt; otomatik mali onay sayılmamalı|
|42|Sistem Dışı Rapor|Rapor görünümü|
|43|Sistem Dışı Dahil Kurye Kazanç|Rapor görünümü|
|44|Bölge Tanımlama|Ekle/sil; yönetim API testi|
|45|İşletme Bölge Fiyatlandırma|Kayıt; hesaplama kuralı NEEDS DECISION|
|46|İşletme Bölge Bazlı Tahsilat|Rapor; tam veri hacmi ayrıca test edilmeli|
|47|Kontör|Gerçek bakiye/hareket; 0+10-3=7 testli|

Restoran ve kurye gerçek oturumla açıldı. Kurye boş ekranında 390 ve 1280 px, restoran boş ekranında 1280 px yatay taşma yok. Dolu liste/tüm modal/mobil klavye/saha navigasyonu için bu sonuç genellenemez.

## K) Test sonuçları

- Başlangıç npm test: 119 toplam / 117 PASS / 0 FAIL / 2 SKIP.
- Son npm test: **131 toplam / 129 PASS / 0 FAIL / 2 SKIP**, 68076.9112 ms.
- Yeni audit dosyası tek başına: 12/12 PASS.
- npm run build: PASS (npm run check; syntax kontrolüdür, APK/EXE derlemesi değildir).
- npm run deploy:preflight: PASS; kontrol anında 267 tracked, 15 required, 0 forbidden; readiness ve startup migrations true.
- capacitor.config.ts için tsc --noEmit --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022: PASS; bütün JavaScript uygulaması typechecked değildir.
- npm run lint / npm run typecheck: **NOT CONFIGURED**, iki script package.json'da yok; PASS diye sayılmadı.
- Ayrı smoke: ilk çalıştırma doğrulanmamış fixture adresinden 422 FAIL; delivery-point fixture düzeltmesinden sonra **PASS**, admin/restoran/kurye/webhook/atama/harita/gün sonu kontrolü tamamlandı.
- Ayrı scripts/load-test.js: geçici SQLite, 50 restoran/100 kurye/300 başlangıç paket; 343 sunucu isteği, 0 HTTP hata. Paket sayısı 316 oldu; aynı platform siparişi tekrarında 201 ardından 200 ve duplicate=true. Yerel SQLite sonucu üretim kapasitesi değildir.
- Yük testi istemci p95: 5/10 eşzamanlı platform siparişi 89/158 ms; 50/100 kurye online 8819/8818 ms; 50/100 restoran onayı 4371/1297 ms; 10 admin bootstrap 317 ms. HTTP başarısı gecikme hedefinin sağlandığı anlamına gelmez; kurye online yoğunluğundaki yaklaşık 8,8 saniye gecikme ayrıca profillenmeli.

## L) Atlanan testlerin nedenleri

İki SKIP operationsUi.test.js içindeki eski admin/restoran arayüzü testidir; yeni tasarım bridge testleri mevcut. test_jsdom.js eski sabit Desktop dosyasına bağlı tanılama betiği; ürün regression takımı değildir. scripts/test-webhook.js aktif hedefe gönderim yapabildiğinden ayrıca canlı çalıştırılmadı; webhook smoke ve otomatik ingress testleri kullanıldı. Windows uygulama testleri kullanıcı kapsamı dışında bırakıldı.

## M) Hâlâ kalan eksikler — önem sırası

**CRITICAL:** Test edilen senaryolarda açık kalan CRITICAL yeniden üretim yok. Bu, sistemin tamamına kritik hata yok sertifikası değildir.

**HIGH / NEEDS DECISION:** Ücret iadesi, ödeme değişikliği, özel/bölgesel fiyatlandırma, sistem dışı onay formları gerçek kayıt tutuyor ancak uçtan uca mali motor değildir. İade kaynağı, dönem kilidi, ters kayıt, fiyat önceliği, başlangıç bakiyesi ve tahsilat mutabakat kuralları kararlaştırılmadan gerçek para etkisi eklenmedi. Ortak journal ile bütün eski mali yolların birleştirilmesi tamamlanmış sayılmaz.

**HIGH / VALIDATION GAP:** Canlı PostgreSQL yarış koşulları, gerçek push ve fiziksel cihaz arka plan takibi bu koşullarda onaylanamaz.

**MEDIUM:** Bootstrap üzerinden raporlanan sınırlı listelerin yüksek hacimde eksiksizliği; her 47 menünün dolu/bozuk veri ve bütün düğme kombinasyonları; genel yönetim kayıtlarının subject/tarih doğrulama kapsamının genişletilmesi; SSE çok instance/replay ve uzun kesinti testi; yerel yük testinde kurye online isteği p95 yaklaşık 8,8 saniye.

**LOW:** Lint/typecheck npm script eksikliği, legacy tanılama/skip testleri, bağımlı CDN/harita sağlayıcıları için offline kullanıcı deneyimi.

## N) Manuel test gereken alanlar

Android gerçek cihazda ekran kilidi, izin reddi/geri verme, pil optimizasyonu, ağ geçişi, GPS kaybı/geri gelişi; bildirim sesi ve uygulama kapalıyken bildirim; kamera/konum dialogları; gerçek yazıcıda otomatik baskı; dolu panellerde mobil klavye/uzun metin; gerçek operasyon yoğunluğu ve farklı adminlerin eşzamanlı mali işlemleri. Bu çalışma EXE/APK yeniden üretmedi.

## O) External credential/API nedeniyle test edilemeyenler

FCM gerçek cihaz teslimi için Firebase/service-account/google-services yapılandırması; iOS native proje/APNs; üretim Web Push tarayıcı-cihaz izinleri; Posentegra ve platformların gerçek hesapları; ödeme sağlayıcısı/banka mutabakatı; canlı PostgreSQL staging kopyası. Mock/yerel sağlayıcı testleri bu doğrulamaların yerine konulmadı.

## Korunan ilgisiz dosyalar

windows-restaurant-app/main.js, package.json, preload.js, auto-print.test.js ve .restomap-presentation/ değiştirilmedi/stage edilmedi. .playwright-mcp/ yalnız yerel tarayıcı denetim çıktısıdır; commit'e alınmaz. Legacy Delivera remote'una push yapılmaz; hedef RESTOMAP origin/main.
