# RESTOMAP — Uygulama Öncesi Denetim Raporu
Tarih: 5 Eylül 2026

## Kapsam ve sonuç

Bu rapor yerel çalışma ağacının kaynak kodu, API yönlendirmeleri, şema/migration tanımları ve seçilmiş izole testlerine dayanır. Canlı Render/PostgreSQL verisi, fiziksel Android cihaz veya yazıcı üzerinde doğrulama yapılmadı. Uygulama kodu değiştirilmedi, migration çalıştırılmadı, push yapılmadı. Önceden bulunan Windows uygulaması değişiklikleri ve sunum dosyaları korunmuştur.

Sistem üç bağımsız demo değildir: ortak backend, packages kayıtları, rol bazlı oturumlar, veritabanı ve SSE canlı olay altyapısı vardır. Ancak bazı menüler yalnızca genel yönetim kaydı oluşturur; kayıt oluşturulması ilgili mali/operasyonel işlemin gerçekleştiği anlamına gelmez. “Bütün özellikler eksiksiz çalışıyor” denemez.

47 menü/giriş aşağıda tek tek incelenmiştir: statik sol menüde 42, sonradan eklenen 4 bağlantı ve Kontör kartı.

## Öncelikli bulgular

### 1. Canlı olaylarda roller arası veri sızıntısı — yüksek öncelik

server.js:4207 streamMatchesAudience, olayda restaurantId yoksa her restoranı; courierId yoksa her kuryeyi kabul ediyor. Yönetim kaydı olayları yalnız ilgili öznenin ID’sini ekliyor (server.js:16580 ve devamı).
Böylece kuryeye özel ceza/izin başlığı ilgisiz restoranın SSE bağlantısına; restorana özel kayıt başlığı ilgisiz kuryenin bağlantısına iletilebilir.

Kaynak fonksiyon, sunucu başlatılmadan yalnız sentetik kimliklerle çalıştırıldı:
- Kurye olayı → ilgisiz restoran: true (istenmeyen).
- Restoran olayı → ilgisiz kurye: true (istenmeyen).
- Kurye olayı → başka kurye: false.

Bu test canlı kişisel veri kullanmadı. Bootstrap özne filtreleri ve kalıcı bildirim filtreleri bulunması, SSE açığını ortadan kaldırmıyor. Çözüm açık hedef rol/ID listesi; genel duyurular için açık broadcast kapsamı olmalı. Hedef alanının olmaması herkese izin anlamına gelmemeli.

### 2. Kontör, bakiye değil kayıt sayısı

admin-design-bridge.js:307 civarında creditRecords.length gösteriliyor. Paket Satın Alma/Kontör, credit_package türünde management_records kaydı oluşturuyor. Gerçek yükleme/tüketim/önceki-sonraki bakiye hareket defteri bulunmadı. Restoran panelinde bakiye ve hareket listesi yok.

Siparişte ne zaman tüketileceği ve iptalde iade kuralı net tanımlanarak transaction + tekrar işlem önleme anahtarı ile uygulanmalı. Kontör geçmişi silinerek düzeltilmemeli; ters kayıt kullanılmalı.

### 3. Ceza/ödül kaydı ile hakediş ayrışabiliyor

server.js:6446–6452 hesaplamasında mevcut bonus/deduction sıfırdan farklıysa yeni kayıt toplamına tercih ediliyor. Bu nedenle yeni ceza/ödül, düzenleme veya silme sonrası eski tutar kalabilir.
- Tarih değişiminde yalnız yeni gün senkronize ediliyor; eski gün düzeltilmiyor.
- Tarihsiz kayıt farklı günlerin hesabına tekrar girebilir; endDate mali etkiyi tanımlamıyor.
- Ödenmiş hakediş için ayrı düzeltme kuralı gerekli.
- Genel kayıt yazımı ve hakediş güncellemesi tek transaction değil: sonraki hata önceki yazımı geri almıyor.

İlk ödül ekleme testi geçiyor; bu, değişiklik/silme senaryolarının doğru olduğunu kanıtlamıyor.

### 4. Genel kayıt formları işlev yerine geçiyor

İade, özel ücret, işletme/bölge fiyatı, paket satın alma ve sistem dışı onay menülerinde veri kalıcıdır; fakat hesaplama/onay motoruna gerçek etki tespit edilmedi. Backend’de kayıt türü ve başlık dışında doğrulama zayıf. management_records subject_id ilişkisel FK değil; created_by alanı yok (ayrı audit log var). Özne varlığı, tür, tarih sırası, durum, miktar ve mali atomiklik tamamlanmalı.

### 5. Raporların kapsamı ve isimleri

- Bootstrap ilk 250 paketi yüklüyor; birçok rapor bunları tüm veri gibi kullanıyor.
- Management-records sorgusu 500 kayıtla sınırlı; uzun dönem hesaplar eksik kalabilir.
- Firma Kazanç sipariş cirosu; net şirket kazancı değil.
- Restoran Bazlı Kurye Kazanç teslimat sayısı gösteriyor.
- Kurye Teslim Süresi oluşturma→teslim; kurye taşıma süresi değil.
- Bazı kazanç raporları güncel ücret kullanıyor; tarihsel hakedişle ayrışabilir.
- Siparişler ve Detaylı Sipariş Raporu aynı işleyiciye gidiyor.
- Raporlara kayıt silme eklenmemeli; kaynak işlemlerde izinli düzeltme ve denetim geçmişi korunmalı.

## Mimari, veritabanı ve yetki

- Backend: Node/JavaScript server.js. Panel bağlantıları admin-design-bridge.js, courier-design-bridge.js ve restaurant-design-bridge.js.
- Veri kaynağı: db/config.js ve db/index.js; yerelde SQLite, üretimde PostgreSQL yapılandırması. Üretimde bağlantı yokken sessiz SQLite’a geçmeme kontrolü var.
- Migration: scripts/migrate.js, schema_migrations ve numaralı migration dosyaları. Sunucu başlangıcında da CREATE/ALTER kodları bulunduğundan tek migration disiplinine yaklaşmak gerekli.
- İncelenen migration: migrations/202608080001_panel_workflow_tables.js.
- Ortak tablolar: packages, couriers, restaurants, management_records, courier_shift_plans, courier_shifts, courier_breaks, courier_earnings, notification_logs, restaurant_panel_data.
- Siparişler aynı packages kimliği ve restoran/atanmış kurye ilişkileriyle paylaşılır. Bu yapı yeniden çoğaltılmamalı.
- Admin/kurye/restoran ayrı oturum tablosundan doğrulanır (server.js:2960, 11923, 11927).
- Kurye workspace ve restoran bootstrap yönetim kayıtlarını özne bazında filtreliyor. Mevcut izole test restoranlar arası kapsamı kontrol ediyor.
- İncelenen yönetim kayıtları API’si admin oturumu istiyor. Yine de tüm endpointlere yönelik saldırı testi yapılmadı; özellikle SSE sorunu nedeniyle genel güvenlik onayı verilemez.
- Realtime SSE + periyodik yenileme. Başka bir WebSocket sistemiyle yeniden yazmak gerekmiyor.
- localStorage kullanımı oturum/arayüz tercihleri/görüldü-yazdırıldı işaretleri için mevcut. İncelenen temel yönetim kayıtları DB’de; “hepsi localStorage demo” doğru değil.
- restaurant_panel_data gerçek DB’de JSON saklıyor; ilişkisel iş kayıtları ve çoklu cihaz eşzamanlı güncelleme için sınırları ayrıca ele alınmalı.

## ADMIN MENÜ DENETİMİ

Her maddede CRUD durumu ilgili mevcut ekran içindir. “DB” yanında yazılan kaynak gerçek okuma kaynağıdır; salt raporun ayrıca DB’ye yazmaması eksik sayılmaz.

Ortak bildirim/yetki notu: Yönetim kaydı değişikliklerinde kalıcı bildirim + workspace-update altyapısı var; yukarıdaki SSE hedefleme açığı giderilmeden doğru alıcı garantisi yok. Menüye erişim kontrolü tek başına yeterli değildir. Aşağıdaki “admin kontrolü” incelenen API yapısını ifade eder, tüm saldırı senaryolarından geçmiş sertifika değildir.

### 1. Operasyon

- Frontend: Gerçek paket listesi ve işlem düğmeleri.
- Backend / DB: Bootstrap ve paket işlem API’leri; packages.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Durum/atama işlemleri var; fiziksel silme yerine mevcut iptal akışı korunmalı.
- Kurye entegrasyonu: Var: atanmış paket ve durum.
- Restoran entegrasyonu: Var: işletmenin paketi ve durumu.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Ortak paket akışı mevcut. Tüm geçmiş için sayfalama ve açık ekran senkronizasyonu sınanmalı.

### 2. Operasyon Haritası

- Frontend: Harita var.
- Backend / DB: Harita/konum API’leri; packages, couriers, restaurants.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Okuma ekranı; CRUD uygulanmaz.
- Kurye entegrasyonu: Konum ve paket hedefleri.
- Restoran entegrasyonu: İlgili paketler.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Canlı Harita ile aynı bileşenin farklı modu; tamamen sahte kopya değil. GPS ölçüm zamanı ile sunucuya geliş zamanı ayrılmalı.

### 3. Siparişler

- Frontend: Detaylı paket raporu açılıyor.
- Backend / DB: Bootstrap; packages.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Bu menü salt okunur; operasyon ekranında durum işlemleri var.
- Kurye entegrasyonu: Ortak paket verisi var.
- Restoran entegrasyonu: Ortak paket verisi var.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Detaylı Sipariş Raporu ile aynı işleyici. Ayrı sipariş yönetimi gibi görünmesine rağmen ayrı işlev sunmuyor.

### 4. İşletmeler

- Frontend: Liste, ekleme ve konum düzenleme var.
- Backend / DB: Restoran oluşturma/konum API’leri; restaurants.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Oluşturma/okuma var; düzenleme konumla sınırlı; bu modalda genel düzenleme/silme yok.
- Kurye entegrasyonu: İşletme konumu atamayı etkiliyor.
- Restoran entegrasyonu: Kendi işletme kaydı mevcut.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: İşletme adı, durum, adres ve genel bilgilerin tam yönetimi eksik; varsayılan koordinatlar gerçek ölçüm gibi kabul edilmemeli.

### 5. Canlı Harita

- Frontend: Kurye odaklı harita var.
- Backend / DB: Konum API’leri; couriers.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Gerçek konum altyapısı var.
- Restoran entegrasyonu: Kendi takip ekranı mevcut.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Offline/eski konum filtresi mevcut. GPS ölçüm yaşı tüm panellerde tutarlı gösterilmeli; gerçek cihaz testi yapılmadı.

### 6. Oto Atama Yönetimi

- Frontend: Sayaçlar ve yeniden ata düğmesi var.
- Backend / DB: /api/admin/rebalance; mevcut atama algoritması.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Gerçek işlem var; ayar CRUD ekranı yok.
- Kurye entegrasyonu: Atama geliyor.
- Restoran entegrasyonu: Atanan kurye görünüyor.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Algoritma korunmalı. Genel izin kayıtları algoritmaya bağlı değil; vardiya/izin uygunluğu mevcut kurallarla kontrollü birleştirilmeli.

### 7. Kuryeler

- Frontend: Liste, ekleme, düzenleme, müsaitlik ve silme var.
- Backend / DB: Kurye yönetim API’leri; couriers.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: CRUD arayüzü var; ilişkili kayıt varken silme sınırları ayrıca sınanmalı.
- Kurye entegrasyonu: Kendi kurye kaydı.
- Restoran entegrasyonu: İlgili kuryeler.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Varsayılan başlangıç koordinatı gerçek GPS değildir. Yönetim kayıtlarının özne ilişkileri güçlendirilmeli.

### 8. Kurye Raporu

- Frontend: Durum raporu var.
- Backend / DB: Bootstrap; couriers ve packages.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Şu an durum/yük/son konum ağırlıklı; izin, mola, çalışma süresi, ödül/ceza içeren kapsamlı rapor değil.

### 9. Haftalık İzin Planı

- Frontend: Genel kayıt formu var.
- Backend / DB: Management-records API; management_records/courier_leave.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil ve durum değiştir var; tam düzenleme formu yok.
- Kurye entegrasyonu: Kısmi: İzin Günüm ekranında yakın tarihli kayıtlar.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: İzin türü/onay durumu, tüm tarih aralığı, tam düzenleme, atama uygunluğu ve açık modalın canlı yenilenmesi eksik.

### 10. Kurye Vardiya & Mola

- Frontend: Vardiya planlama ekranı var.
- Backend / DB: Vardiya plan API’leri; courier_shift_plans, courier_shifts, courier_breaks.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Plan ekle/oku/sil var; aynı gün plan kaydı güncellenebiliyor, belirgin düzenleme formu yok.
- Kurye entegrasyonu: Vardiya ve gerçek mola işlemleri mevcut.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Admin formunda planlı mola başlangıç/bitiş ve not yok. Kurye mola bütçesi 5 dakika sabit.

### 11. Kurye Ceza & Ödül Kaydı

- Frontend: Genel kayıt formu var.
- Backend / DB: Management-records API; courier_adjustment ve courier_earnings.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum var; tam düzenleme UI yok.
- Kurye entegrasyonu: Kısmi: ödül/kesinti listesi zaten mevcut.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Güncellenen/silinen tutar hakedişe doğru yansımayabilir. Tarih değişince eski gün de hesaplanmalı; not/bitiş ve işlem yapan ilişkisi tamamlanmalı.

### 12. Ödeme Değişiklikleri

- Frontend: Genel kayıt formu var.
- Backend / DB: Management-records API; payment_change.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; tam düzenleme UI yok.
- Kurye entegrasyonu: Kayıt ve not gösteriliyor.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Bilgilendirme kaydı gerçek ödeme düzeltmesiyle aynı şey değil; mali etkisi ve bağlı işlem açıkça tanımlanmalı.

### 13. Kurye Performans

- Frontend: Tarihli performans ekranı var.
- Backend / DB: /api/admin/courier-performance; gerçek operasyon verileri.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi kendi raporları.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: İzin, çalışma süresi, mola ve hakediş ile ortak rapor tanımı tamamlanmalı.

### 14. Kurye Tahsilat

- Frontend: Mutabakat ekranı var.
- Backend / DB: Nakit mutabakat API; cash reconciliation kayıtları.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Okuma ve bildirilen nakit/durum/not güncelleme var; mali kayıt silme normal CRUD sayılmamalı.
- Kurye entegrasyonu: Gün sonu/nakit bağlantısı var.
- Restoran entegrasyonu: Doğrudan uygulanmaz.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Düzeltme geçmişi, işlem atomikliği ve mali tutarlılık senaryoları genişletilmeli.

### 15. Kurye Nakitleri

- Frontend: Özet rapor var.
- Backend / DB: Bootstrap içindeki nakit mutabakat kayıtları.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: İlgili mali veri mevcut.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Sınırlı yüklenmiş kayıtlar tüm tarihçe gibi sunulmamalı; tarih filtresi/sayfalama gerekli.

### 16. İşletme-kurye teslim takibi

- Frontend: Paket ilişkisi raporu var.
- Backend / DB: packages içindeki restoran/atanmış kurye ilişkileri.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur; ayrı olay CRUD yok.
- Kurye entegrasyonu: Paket bazında var.
- Restoran entegrasyonu: Paket bazında var.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Mevcut kodda genel ödül/ceza formu değil. Eksik teslim gibi ortak not/olay isteniyorsa paket+işletme+kurye bağlı kayıt ve görünürlük gerekli.

### 17. Kurye Ücretlendirme

- Frontend: Paket başı ücret formu var.
- Backend / DB: Kurye güncelleme API; courier ücret alanı.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Okuma/güncelleme var; silme yerine ücret değişikliği.
- Kurye entegrasyonu: Hakediş varsayılanına bağlı.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Tarihsel ücret anlık görüntüleri korunmalı; ücret değişikliği eski raporu yeniden fiyatlandırmamalı.

### 18. Kurye Kazanç

- Frontend: Hakediş oluşturma ve ödendi işlemi var.
- Backend / DB: Hakediş API’leri; courier_earnings.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Oluştur/oku/ödendi var; silme yerine mali düzeltme yaklaşımı.
- Kurye entegrasyonu: Kısmi.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Ceza/ödül senkronizasyon hatası ve kurye özetinin aynı hakediş kaynağına bağlanması gerekli.

### 19. Restoran Bazlı Kurye Kazanç

- Frontend: Gruplanmış rapor var.
- Backend / DB: Bootstrap packages.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi.
- Restoran entegrasyonu: Restoran gruplaması var.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Mevcut rapor teslimat SAYISI gösteriyor; adı kazanç olsa da gerçek tutar hesaplamıyor.

### 20. Kurye Havuz Yetkileri

- Frontend: Uygunluk listesi var.
- Backend / DB: Bootstrap kurye/paket verileri; ayrı yetki API’si yok.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur; yetki CRUD yok.
- Kurye entegrasyonu: Havuz alma backend’i ayrıca mevcut.
- Restoran entegrasyonu: Atama sonuçları var.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Yetki yönetimi değil, frontend uygunluk özeti. Backend’in mesafe/GPS/kapasite kararının tam karşılığı değil.

### 21. Havuz Sipariş Geçmişi

- Frontend: Filtrelenmiş paket raporu var.
- Backend / DB: Bootstrap packages.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Paketler ortak.
- Restoran entegrasyonu: Paketler ortak.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Atama nedeni/havuzda bekleme filtresi; değişmez havuz olay günlüğü değil. Yeniden atama geçmişi kaybolabilir.

### 22. Günlük Sipariş Raporu

- Frontend: Tarihli rapor var.
- Backend / DB: /api/admin/reports/account; DB sorgusu.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: İşletme filtreli.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Gerçek backend raporu; toplam ve durum tanımları diğer raporlarla eşitlenmeli.

### 23. Detaylı Sipariş Raporu

- Frontend: Detay raporu var.
- Backend / DB: Bootstrap packages.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Ortak veri.
- Restoran entegrasyonu: Ortak veri.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Siparişler ile aynı ekran. İlk 250 kayda dayalı rapor tüm geçmiş sanılmamalı.

### 24. Parçalı Ödeme Raporu

- Frontend: Filtreli rapor var.
- Backend / DB: packages tutar/tahsil edilen alanları.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: Dolaylı.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Tahsil edilen < sipariş tutarı filtresi, ödeme parçalarının yöntem/tarih bazlı hareket defteri değil.

### 25. Kurye Teslim Süre Raporu

- Frontend: Süre raporu var.
- Backend / DB: packages oluşturulma/teslim zamanları.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi.
- Restoran entegrasyonu: Dolaylı.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Oluşturulmadan teslime süre hazırlığı da kapsar. Teslim alma→teslim ile ayrılmalı; tarih/kurye filtresi gerekli.

### 26. Kurye Ödeme Türü Raporu

- Frontend: Ödeme türü gruplaması var.
- Backend / DB: Bootstrap packages.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi.
- Restoran entegrasyonu: Dolaylı.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Kurye bazlı kırılım değil, yüklenen tüm paketlerin ödeme yöntemi grubu; dönem ve durum ayrımı eksik.

### 27. Kurye Ceza & Ödül Raporu

- Frontend: Genel kayıt raporu var.
- Backend / DB: management_records/courier_adjustment.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi liste.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Tüm durumların toplamı gerçek mali etki değildir; dönem, kurye, geçerli/iptal ayrımı ve hakediş mutabakatı gerekli.

### 28. Firma Kazanç

- Frontend: Restoran bazlı tutar raporu var.
- Backend / DB: Teslim edilmiş packages.orderAmount.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: Dolaylı.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Sipariş cirosunu topluyor; şirketin net kazancı veya hizmet geliri değil. İsim ve hesap tanımı düzeltilmeli.

### 29. İşletme Tahsilat

- Frontend: Hesap/mutabakat ekranı var.
- Backend / DB: /api/admin/accounting/restaurants ve ödeme işlemleri.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Oku/ödendi/görüntüle var; mali silme yerine düzeltme.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: Ortak hesap verileri kısmi.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Restoran tarafı aynı mali hareketleri kapsamlı göstermeli; atomik ödeme ve geri alma senaryoları sınanmalı.

### 30. Restoran Hesap Raporu

- Frontend: Tarih aralıklı hesap raporu var.
- Backend / DB: /api/admin/reports/account.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: İşletme filtreli.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Gerçek sorgu mevcut; mali kayıt kaynağı ve iade/kontör etkisi ayrı netleştirilmeli.

### 31. İşletme Ücret İadesi

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/restaurant_refund.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; tam düzenleme UI yok.
- Kurye entegrasyonu: Doğrudan uygulanmaz.
- Restoran entegrasyonu: API’de özneye göre veri var, mevcut UI göstermiyor.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: İade kaydı oluşturuyor; tahsilat/hareket defterine gerçek iade etkisi tespit edilmedi.

### 32. Entegrasyon Yönetimi

- Frontend: Hesap listesi ve bağlantı testi var.
- Backend / DB: Platform hesapları + check-connection API.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Bu ekranda oluştur/düzenle/sil yok.
- Kurye entegrasyonu: Sipariş akışı üzerinden dolaylı.
- Restoran entegrasyonu: Platform siparişleri üzerinden.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Backend altyapısı var; mevcut panel tam yönetim sunmuyor. Harici sağlayıcı bağlantısı bu denetimde çalıştırılmadı.

### 33. Kurye Özel Ücretlendirme

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/courier_special_pricing.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; tam düzenleme UI yok.
- Kurye entegrasyonu: Özne verisi var; ücret etkisi yok.
- Restoran entegrasyonu: Uygulanmaz.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Kayıt tutulması, hakediş motorunun özel fiyat uygulaması anlamına gelmiyor; tüketen hesaplama tespit edilmedi.

### 34. İşletme Ücretlendirme

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/restaurant_pricing.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; tam düzenleme UI yok.
- Kurye entegrasyonu: Dolaylı olması gerekir.
- Restoran entegrasyonu: UI karşılığı yok.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Gerçek fiyat hesaplama/tahsilat etkisi bağlanmalı; mevcut kayıt motoru tek başına yeterli değil.

### 35. Restoran Fiyatlandırması

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/restaurant_menu_pricing.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; tam düzenleme UI yok.
- Kurye entegrasyonu: Uygulanmaz.
- Restoran entegrasyonu: UI karşılığı yok.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: İşletme Ücretlendirme ile benzer form ama farklı tür. Menü fiyatı mı hizmet tarifesi mi açık kural ve tüketici yok.

### 36. Paket Satın Alma

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/credit_package.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; bakiye işlemi değil.
- Kurye entegrasyonu: Uygulanmaz.
- Restoran entegrasyonu: Bakiye/hareket ekranı yok.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Gerçek kontör yükleme, tüketim, bakiye, idempotent hareket defteri yok; ödeme/satın alma işlemi sayılmamalı.

### 37. Sistem Dışı Onaylar

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/external_approval.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; paket onayı değil.
- Kurye entegrasyonu: Genel özne verisi kısmi.
- Restoran entegrasyonu: Paketle gerçek onay bağı eksik.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Tamamla düğmesi paket onay durumunu değiştirmiyor; order ilişkisi ve onay komutu gerekli.

### 38. Sistem Dışı Rapor

- Frontend: Kaynak filtreli rapor var.
- Backend / DB: packages source filtresi.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Ortak veri.
- Restoran entegrasyonu: Ortak veri.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Yüklenen paketlerle sınırlı; kaynak tanımı, tarih/sayfalama ve onay bağlantısı doğrulanmalı.

### 39. Sistem Dışı Dahil Kurye Kazanç

- Frontend: Hesaplanan rapor var.
- Backend / DB: Bootstrap packages + güncel kurye ücreti.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Kısmi.
- Restoran entegrasyonu: Dolaylı.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Güncel ücret×teslimat yaklaşımı tarihsel kazancı değiştirebilir; kesin hakediş hareketlerinden hesaplanmalı.

### 40. Bölge Tanımlama

- Frontend: Bölge yönetimi var.
- Backend / DB: Bölge API; zones.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil var; yeniden adlandırma UI yok.
- Kurye entegrasyonu: Atama bölgesi dolaylı.
- Restoran entegrasyonu: İşletme bölgesi dolaylı.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Kullanılan bölgeyi silme/yeniden adlandırma ilişkileri ve yetim kayıt koruması sınanmalı.

### 41. İşletme Bölge Fiyatlandırma

- Frontend: Genel kayıt formu var.
- Backend / DB: management_records/restaurant_zone_pricing.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Ekle/oku/sil/durum; tam düzenleme UI yok.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: UI karşılığı yok.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Yapısal bölge ilişkisi/fiyat motoru etkisi yok; başlık alanına kural yazmak fiyat kuralı uygulamaz.

### 42. İşletme Bölge Bazlı Tahsilat

- Frontend: Bölge gruplu rapor var.
- Backend / DB: Restoran muhasebe verisi.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: Dolaylı.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Gerçek veriyi grupluyor; dönem seçimi ve fiyat kurallarıyla tutarlılık tamamlanmalı.

### 43. Restoran Giriş Bilgileri

- Frontend: Kimlik bilgisi düzenleme var.
- Backend / DB: /api/admin/restaurants/:id/credentials; restaurants/oturumlar.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Oku/güncelle var; ekleme İşletmeler üzerinden; silme uygulanmaz.
- Kurye entegrasyonu: Uygulanmaz.
- Restoran entegrasyonu: Parola değişiminde oturumları etkiler.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Parola değişiminde eski oturum iptali mevcut. Yetkisiz erişim regresyon testleri genişletilmeli.

### 44. Eşleşmeyen Paketler

- Frontend: Özel çalışma ekranı var.
- Backend / DB: Eşleşmeyen sipariş/çözümleme API ve kayıtları.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Çözümleme iş akışı var; tam CRUD bu denetimde uçtan uca sınanmadı.
- Kurye entegrasyonu: Eşleşme sonrası ortak paket.
- Restoran entegrasyonu: Eşleşen işletmenin paketi.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Sağlayıcı bazlı gerçek örnekler ve yeniden deneme/çift kayıt önleme ayrıca test edilmeli.

### 45. Restoran Cihaz Kurulumu

- Frontend: Kurulum dosyası indirme işlemi var.
- Backend / DB: Statik /downloads/restomap-restoran-kurulum.cmd.
- Kayıt ve tekrar okuma: Dosya indirme; DB kaydı gerekmez.
- Düzenleme / silme: DB/CRUD uygulanmaz.
- Kurye entegrasyonu: Uygulanmaz.
- Restoran entegrasyonu: Cihaz kurulumuna yönelik.
- Bildirim: İlgili durum/değişiklik için mevcut canlı olaylarla uyum gerekli; bu menüye özel tam teslim testi yapılmadı.
- Yetki: İndirme, kullanıcı verisi okuma yetkisiyle aynı işlem değildir.
- Eksik / değerlendirme: İndirmeyi başlatınca başarı bildiriyor; gerçek indirme/kurulum/yazıcı sonucu doğrulanmış sayılmaz. EXE çalışmasına dokunulmadı.

### 46. İşletme Tarih Aralığı

- Frontend: Tarih aralıklı rapor var.
- Backend / DB: /api/admin/reports/account.
- Kayıt ve tekrar okuma: DB verisi okunuyor; rapor yazma işlemi gerektirmez.
- Düzenleme / silme: Salt okunur.
- Kurye entegrasyonu: Dolaylı.
- Restoran entegrasyonu: İşletme filtreli.
- Bildirim: Salt görüntüleme için yeni bildirim gerekmez; kaynak değişikliklerinin yenilenmesi gerekir.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Restoran Hesap Raporu ile ortak altyapı; farkı kullanıcıya açık olmalı.

### 47. Kontör

- Frontend: Kart ve genel kayıt modalı var.
- Backend / DB: management_records/credit_package; ledger yok.
- Kayıt ve tekrar okuma: Yukarıdaki veri kaynağı üzerinden mevcut; işlevsel etki sınırı aşağıda.
- Düzenleme / silme: Genel kayıt CRUD kısmi; bakiye CRUD yok.
- Kurye entegrasyonu: Uygulanmaz.
- Restoran entegrasyonu: Kontör ekranı yok.
- Bildirim: İlgili kullanıcıya değişiklik bildirimi gerekli; genel kayıt altyapısı var, SSE hedefleme hatalı.
- Yetki: Admin API/oturum kapsamı mevcut; ilgili kullanıcı okuması özneye göre olmalı. Ortak SSE açığı geçerli.
- Eksik / değerlendirme: Kart aktif kayıt ADEDİNİ gösteriyor, kontör bakiyesini değil. En kritik işlevsel eksiklerden biri.

## KURYE PANELİ EKSİKLERİ

1. Ödül/kesinti listesi zaten var; tamamen yok değil. Tam not, bitiş, açık tür, dönem filtreleri ve doğru hakediş tutarıyla eşleştirme eksik.
2. İzin Günüm yakın 7 günü özetliyor. Tam İzinlerim geçmişi/geleceği, tür/onay durumu ve düzenleme sonrası açık ekran güncellemesi gerekli.
3. Vardiya başlat/bitir ve gerçek mola kayıtları mevcut. Adminin planlı mola saatleri/notu tanımlaması ve kuryede görüntülenmesi eksik. Sabit 5 dakikalık mola bütçesi politika yerine geçmemeli.
4. Performans raporunda gerçek çalışma, mola, izin ve mali hareketler tek tutarlı hesaplama kaynağında birleşmeli.
5. Backend duyuru verisi var; mevcut bridge’de görünür kapsamlı Duyurular ekranı bulunmadı.
6. SSE geldiğinde veri yeniden yüklense de açık modalın içeriği otomatik yeniden çizilmiyor; kullanıcı eski izin/ödül ekranında kalabilir.
7. Kendi kayıtlarını okuma ve başka kurye ID’siyle erişim denemeleri GET/PATCH/DELETE/SSE dahil genişletilmeli.
8. Konum ölçüm zamanı, internetten dönüş ve gerçek Android arka plan davranışı fiziksel cihaz testi gerektiriyor; kaynak incelemesiyle “sorunsuz” denemez.
9. Birden fazla paket hedef seçimi bu rapor kapsamında değiştirilmedi; mevcut atama/havuz akışı korunacak.

## RESTORAN PANELİ EKSİKLERİ

1. Backend scoped managementRecords döndürüyor ancak mevcut restaurant-design-bridge bunları göstermiyor. İlgili admin notları/iade/ücret/operasyon kayıtları görünür değil.
2. Kontör bakiyesi/hareketleri ve gerçek ledger yok.
3. İşletme bilgilerinin kendi hesabında tam görüntülenmesi ve admin değişikliklerinin kapsamlı yansıması gerekli.
4. Ortak sipariş, atanan kurye ve teslimat durumu altyapısı var; yeniden oluşturulmayacak.
5. İşletme-kurye ortak olayında iki tarafa ait ID + paket ilişkisi ve yetkili görünürlük gerekli.
6. Arama Geçmişi mevcut kodda yalnız sipariş aramasına odaklanıyor; gerçek arama geçmişi değil (restaurant-design-bridge.js:1386 ve devamı).
7. Kurye Teslim Onayları aktif paket filtresi açıyor; ayrı bir onay kuyruğu/komutu sunduğu varsayılmamalı.
8. Eşleşmeyen route fallback’i sadece “bölümü açıldı” toast’ı gösterebiliyor; desteklenen tüm menüler açık işleyiciye bağlanmalı.
9. Açık rapor/modal yenilemesi ve tarih/sayfalama eksikleri giderilmeli.
10. POS JSON verisinin kalıcı olması olumlu; çoklu cihazda eşzamanlı yazma/çatışma ve rapor kapsamı ayrıca sınanmalı. Bu denetim POS entegrasyon sağlayıcısına bağlantı testi değildir.

## Bildirim, boş özellik ve tekrar eden ekran taraması

- Bildirim sayacı kayıt sayısını gösteriyor; backend listelerinde read_at/okunmadı ayrımı olmadan gerçek okunmamış sayacı sayılmaz.
- Admin bağlantı metni, bağlantı kopmasını güvenilir biçimde temsil etmeli; polling hatasını sessiz geçmek “canlı” garantisi değildir.
- Başlangıç HTML şablonunda örnek sayaçlar bulunuyor; bridge bunları değiştiriyor. Yükleme/hata durumunda örnek değer görünmesi engellenmeli.
- Adminin bilinmeyen menü fallback’i genel kayıt formu oluşturabiliyor. Bu, yeni bir menünün otomatik gerçek modüle dönüştüğü anlamına gelmez.
- Yeni admin Entegrasyon Yönetimi yalnız bağlantı testi sunuyor; backend’deki yönetim yetenekleri bu ekranda tamamlanmamış.
- Statik kurulum indirmesi ve destek/dokümantasyon bağlantıları için gerçek hedef/başarı testi bu denetimde tamamlanmadı; “hepsi çalışıyor” olarak işaretlenmedi.
- Genel kayıt formunda “Tamamla” yalnız status değiştiriyor. İade yapılması, kredi yüklenmesi veya sipariş onaylanması değildir.

## Test sonuçları ve sınırları

Çalıştırılan komut:
```text
node --test --test-concurrency=1 test/adminManagementCrud.test.js test/adminDesignWorkflow.test.js test/courierDesignWorkflow.test.js test/restaurantDesignLiveEvents.test.js test/courierPoolClaim.test.js test/courierEarnings.test.js
```

Sonuç: 6 test, 6 başarılı, 0 başarısız. İzole test veritabanları kullanıldı.

Kapsananlar:
- Admin görünümünün backend paketlerini ve canlı olayları kullanması.
- Vardiya/izin/ödül/bölge kayıtlarının kalıcılığı; ilgili kurye workspace’i ve restoran kapsamı.
- Kurye kabul/yola çık/teslim/mola temel akışı.
- Günlük hakediş tekrarının önlenmesi.
- Oto atamanın önceliği ve dolu kuryenin havuzdan ek paket alması.
- Restoran görünümünde kapalı paket filtresi/canlı olay aboneliği.

Ek kontrol: SSE hedef fonksiyonu sentetik kimliklerle çalıştırıldı, roller arası istenmeyen teslim doğrulandı.

Bu 6 test, talepteki 7 senaryonun tamamı veya canlı cihaz uçtan uca testi değildir. Özellikle ceza değiştirme/silme muhasebesi, ikinci kurye ID saldırıları, kontör ledger’i ve açık modal senkronizasyonu için eksik testler var. Test çıktısında SQLite experimental uyarısı ve jsdom belge navigasyonu sınırlaması görüldü; başarısız test yok fakat gerçek tarayıcı navigasyonu doğrulanmış sayılmaz.

## Geliştirme sırası

Talepteki sıraya bağlı kalınacak; her modülün testleri o modülle birlikte yazılacak:

1. Ortak backend/veri modeli: mevcut management_records yeniden kullanılacak; özne ilişkileri, işlem yapan, tür/durum/tarih doğrulamaları, mali transaction ve ledger gereksinimleri tamamlanacak. Veri silinmeden geriye uyumlu migration.
2. Authorization: SSE rol sızıntısı öncelikli; API ve olaylar için aynı açık hedef kuralı, başkasının ID’siyle okuma/yazma testleri.
3. Admin CRUD: izin/ödül/ceza tam düzenleme, vardiya/mola/not; genel kaydın gerçek mali/operasyon etkisi. Mali geçmiş için ters işlem.
4. Kurye entegrasyonları: kendi izinleri, ödül/cezaları, vardiyası, performansı ve duyuruları.
5. Restoran entegrasyonları: kendi kayıtları, kontör/hareketleri, ortak operasyon olayları.
6. Bildirimler: hedefli kalıcı kayıt, okunma durumu; ilgili değişiklikler.
7. Realtime: mevcut SSE korunarak açık modal dahil senkronizasyon, bağlantı durumu ve yeniden bağlanma.
8. Raporlar: tam veri üzerinden backend sorguları, ortak mali tanımlar, dönem/sayfalama, tarihsel fiyat.
9. UI polish: mevcut tema/sidebar/modal düzeni korunacak; yalnız eksik alanlar, loading/error/empty ve mobil taşma.
10. Son test turu: talepteki yedi senaryo + güncelleme/silme + paralel işlem/idempotency + SQLite/PostgreSQL uyumu + gerçek tarayıcı/cihaz kontrolü.

Atama algoritması ve ana sipariş akışı yeniden yazılmayacak. Kontör tüketim anı, iade politikası ve özel fiyat öncelikleri açık iş kurallarıyla ele alınacak; rastgele mali davranış eklenmeyecek.

## Kaynak işaretleri

- admin-design-source/code.html: statik menü envanteri.
- admin-design-bridge.js:110 dinamik menüler; 307 kontör; 314 hydrate; 557 işletmeler; 732 vardiya; 746 genel kayıt; 785–860 raporlar; 963 route eşleşmeleri; 1037 ana yönlendirme.
- server.js:4207 SSE alıcı filtresi; 6446 hakediş düzeltmeleri; 6728 GPS uygunluğu; 7171 atama adayları; 7845–7910 yönetim kayıtları; 16573 yönetim endpointleri.
- courier-design-bridge.js:1254 civarı raporlar; 1396 vardiya; 1425 izin; 1542 mola.
- restaurant-design-bridge.js:1386 menü yönlendirmeleri.
- db/config.js, db/index.js, scripts/migrate.js ve migrations/202608080001_panel_workflow_tables.js.
- test/adminManagementCrud.test.js ve yukarıdaki beş test dosyası.

Bu belge, talebin “önce kodu değiştirmeden audit raporu ver” aşamasının çıktısıdır. Uygulama düzeltmeleri henüz yapılmış değildir.

