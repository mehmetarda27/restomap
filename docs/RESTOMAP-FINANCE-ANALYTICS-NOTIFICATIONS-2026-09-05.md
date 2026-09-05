# RESTOMAP — Finans, Analitik ve Bildirim: Ön Analiz ve İlk Aşama
Tarih: 5 Eylül 2026

## Durum

Talepteki analiz aşaması yapıldı; finans kayıt temelinin ilk uygulaması eklendi.
Üç modülün tamamı bitmiş veya üretime alınmış DEĞİLDİR.
Yeni finans servisi henüz HTTP endpointlerine, sipariş teslimine veya panellere bağlanmadı.
Canlı/yerel çalışma veritabanına migration çalıştırılmadı. Testler ayrı test DB’lerinde.
Bu çalışma push edilmedi. Önceden kalan Windows/EXE değişiklikleri korunuyor.

## FİNANS — mevcut altyapı

Mevcut kaynaklar:
- packages: tek ortak sipariş, restaurant_id, assigned_courier_id, teslim/tahsil durumları ve tutarlar.
- courier_earnings: kurye+gün tekil hakediş, bonus, kesinti, ödeme durumu.
- courier_earning_items: hakedişin paket kalemleri ve package_fee.
- restaurant_settlements: işletme+tarih aralığı mutabakatı, ücret ve ödeme durumu.
- cash_reconciliations ve courier_daily_reports: kurye tahsilat/gün sonu.
- management_records: ceza/ödül ve diğer yönetim kayıtları.
- audit_logs: işlem yapan/kayıt/işlem ayrıntısı.
- system settings ve courier per_package_fee: mevcut ücret kaynakları.

Bunların yerine aynı işi yapan ikinci tablolar açılmayacak. Özellikle yeni bir orders/users/notifications kopyası planlanmıyor.

### Eksikler / hatalar

1. server.js normalizeMoney negatif sayıları fallback değere çeviriyor. Management-record oluşturma da bunu kullandığından negatif ceza sıfırlanabilir. Yeni sınırda işaretli para tipi gerekli; global parser’ı körlemesine değiştirmek sipariş akışını etkiler.
2. Mevcut hakedişte sıfır olmayan bonus/kesinti yeni hesaplanan toplama tercih ediliyor. Güncelleme/silme ve tarih değişimi tutarlı değil.
3. Günlük hakediş var; istenen DRAFT/CALCULATED/APPROVED/PAID dönem yaşam döngüsü yok.
4. Ödendi bayrağı gerçek ödeme hareketi, yöntem/referans ve bakiye defteri yerine geçmiyor.
5. Restoran hizmet bedeli mevcut ayardaki ücret × paket sayısı ile hesaplanıyor; tarihsel ücret/komisyon değişimini koruyan kesin mali olay eksik.
6. Sipariş cirosu şirket geliri değildir. Müşteri adına tahsil edilen para ayrıca emanet/karşı hesap mantığına ihtiyaç duyabilir.
7. Kontör mevcut sistemde aktif yönetim kaydı sayısı; finansal bakiye değil.
8. Eski siparişte gerçek gerçekleşme anı ücreti yoksa bugünün ücretinden geçmiş hakediş tahmin edilmemeli.
9. Mevcut tutar alanları REAL; yeni finans hesapları güvenli tam kuruşla yapılmalı. Eski verinin dönüşümü doğrulanmış, kontrollü migration olmalı.

### Kullanılacak / genişletilecek tablolar

- courier_earnings / courier_earning_items: günlük detay ve mevcut bağlantılar korunacak; dönem/snapshot gereksinimi ayrıca geriye uyumlu bağlanacak.
- restaurant_settlements: var olan mutabakat korunacak.
- management_records: mevcut ödül/ceza kaynağı; doğrulama ve mali düzeltme bağlantısı eklenecek.
- audit_logs: mevcut denetim izi kullanılacak.
- packages, couriers, restaurants, admins: FK ile bağlanılacak.
- Gerçek ödeme, komisyon sürümü ve dönem üst kaydı gerektiğinde mevcut tablolarla aynı amacı tekrarlamayan ilaveler yapılacak. Bunlar henüz oluşturulmadı.

### Bu aşamada eklenen tablolar

migrations/202609050001_financial_journal.js:
- financial_journals: olay anahtarı, tür, içerik özeti, TRY, gerçekleşme/kayıt zamanı, admin ilişkisi, neden ve ters kayıt bağı.
- financial_entries: dengeli borç/alacak satırları; BIGINT kuruş, hesap kodu, kurye/restoran/paket FK’leri.
- Olay anahtarı tekil; ters kayıt bağı tekil; tarih ve özne sorgu indeksleri var.
- Eski hakediş/mutabakat tabloları tekrar oluşturulmadı; açılış bakiyesi uydurulmadı.

Bu iki tablo ödeme veya hakedişin ikinci kopyası değildir; gelecekte o işlemlerin mali karşılıklarını tutacak kayıt defteridir.

### Hesaplama ilkeleri

- API para girdisi kanonik ondalık metin; dahili hesap ve DB tam kuruş.
- 0.10 + 0.20 = 30 kuruş; -500 TL işaretini kaybetmez.
- Yüzde basis point ile: 500 = %5; satır düzeyinde bir kez yarımdan dışarı yuvarlama.
- Kurye net = gerçekleşme anındaki teslim ücretleri + ödül/ek ödeme − ceza/kesinti.
- Hizmet geliri = teslimat hizmet bedeli + geçerli komisyon; sipariş ürün tutarı bunun yerine kullanılmaz.
- Tahsilat alacağın kapanmasıdır; gelir ikinci kez kaydedilmez.
- Kurye ödemesi borcun kapanmasıdır; gider ikinci kez yazılmaz.
- Net operasyon sonucu tanımlanmış hizmet gelirleri − hakediş/operasyon giderleri. Vergi ve tüm şirket giderleri yokken “şirket net kârı” denmeyecek.
- Hatalı hareket değiştirilmeyecek/silinmeyecek; sebep ve yapan bilgisiyle ters kayıt.
- Post işlemi ve tüm satırlar transaction; dış push ağ çağrısı transaction içinde yok.
- Eski tarihli fiyat/komisyon eksikliği sıfır ya da bugünün fiyatıyla gizlenmeyecek.

## RAPORLAMA

### Mevcut verilerle üretilebilir

- Gün/saat/hafta/ay sipariş trendi, durum dağılımı, teslim/iptal/aktif sayısı.
- Kurye/işletme bazlı paket ve teslimat sayısı, ortalama sipariş tutarı.
- Oluşturma→teslim ve varsa teslim alma→teslim süreleri ayrı.
- Kaydedilmiş vardiya/mola süreleri; tamamlanmamış vardiyalar açıkça belirtilerek.
- Mevcut hakediş kalemleri ve mutabakat; veri kapsamı açıkça gösterilerek.

### Eksik/veri kalitesi

- Tarihsel fiyat/komisyon snapshot, gerçek ödeme hareketleri, cari açılış bakiyesi.
- İzin/ödül/cezanın güvenilir parasal ve durum doğrulaması.
- Bazı raporlar ilk 250 bootstrap paketiyle hesaplanıyor; tüm veri değil.
- Aktif kurye “şimdi online” ile “dönemde çalışmış” olarak ayrı metrik olmalı.
- Kayıp zaman damgası 0 süre sayılmamalı; hesaplanamayan adet açıklanmalı.
- Tüm raporlar ve CSV aynı backend sorgu/filtre tanımını kullanmalı.
- Türkiye iş günü sınırları ve UTC zamanlarının dönüşümü ortak olmalı.
- SQL aggregation, tarih/özne indeksleri, sayfalama; bütün paketleri frontend’e taşıma yok.
- CSV’de formül enjeksiyonu koruması ve özne yetkisi gerekli.

Yeni rapor endpointi/grafik henüz eklenmedi. Üretim kapasite testi yapılmadı.

## BİLDİRİM

### Mevcut altyapı

- notification_logs: target_role, target_id, event_type, message, created_at.
- broadcastLiveEvent ve SSE: açık panel güncellemeleri.
- courier_push_subscriptions / restaurant_push_subscriptions: bir özneye birden çok endpoint saklanabilir; tek kullanıcıya tek token modeli değil.
- web-push + VAPID ve courier-push-sw.js.
- Geçersiz 404/410 abonelikleri siliniyor; push hatası loglanıyor.
- Android DeliveraCourierService.java mevcut workspace bildirimlerini okuyup yerel Android bildirimi gösterebiliyor.
- Android kaynaklarında tamamlanmış native FirebaseMessagingService/FCM cihaz kayıt zinciri bulunmadı. Firebase alan adına izin vermek FCM entegrasyonu değildir.
- Native iOS uygulaması bu incelemede bulunmadı.

### Eksikler

1. Önceki rapordaki SSE roller arası alıcı sızıntısı halen mevcut; yeni finans olayları buna bağlanmamalı.
2. notification_logs içine read_at, başlık, yapılandırılmış hedef veri, önem, olay tekilleştirme ve sayfalama eklenmeli; ayrı notification kopyası değil.
3. Kalıcı outbox/delivery denemesi, retry/backoff, durum ve hata kaydı yok. Mevcut bellekteki dedup sunucu yeniden başlatılınca kalıcı değil.
4. Olay türleri tüm finans/izin/duyuru senaryolarını kapsamıyor.
5. Açık uygulama, push ve Android polling aynı event ID üzerinden tekilleştirilmeli.
6. Logout, hesap değişimi, token yenileme ve cihaz devre dışı lifecycle doğrulanmalı.
7. Service worker tıklaması mevcut pencereyi kurye yolu üzerinden arıyor; rol/hedef detay yönlendirmesi genelleştirilmeli.
8. Restoran push hatırlatma davranışı yeni merkezi tekrar önleme ile çakışmadan ele alınmalı.
9. Gönderim kaydı “telefon gerçekten gösterdi” garantisi sayılmamalı.

### Platform sınırları

- iOS/iPadOS Web Push, desteklenen sürümde ana ekrana eklenmiş web uygulaması ve izin koşullarına bağlıdır. Kaynak: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Android’de ayarlardan zorla durdurma sonrası uygulamanın yeniden açılması gerekebilir; FCM her koşulda teslim garantisi değildir. Kaynak: https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages
- RESTOMAP için gerçek FCM proje/uygulama kaydı ve sunucu kimlik bilgileri doğrulanmadı. Gizli anahtarlar repoya konmayacak.
- Gerçek Android/iPhone kapalı uygulama, ekran kilidi, izin reddi, internet dönüşü testleri henüz yapılmadı.

## İlk uygulama ve test kapsamı

Eklenen servisler:
- services/financeMoney.js: kesin ondalık metin ↔ kuruş, güvenli toplam ve yüzde.
- services/financialJournalService.js: atomik dengeli mali kayıt, içerik karşılaştırmalı idempotency, FK doğrulaması, yalnız eklenen ters kayıt.
- test/financialJournal.test.js: ayrı bellek DB üzerinde 11 test.

Başarılı 11 senaryo:
1. Kuruş hassasiyeti ve negatif ceza.
2. Belirsiz/sınır aşan para reddi.
3. Yüzde yuvarlama.
4. Dengeli tahsilat satırları/özne ilişkisi.
5. Aynı olay tekrarında tek kayıt.
6. Aynı anahtar farklı içerikte conflict.
7. FK hatasında tüm transaction rollback.
8. Dengesiz/öznesiz kayıt reddi.
9. Ters kayıt, tekrar ters kaydın engellenmesi ve değişmeyen asıl kayıt.
10. Sahte reversal, desteklenmeyen para birimi, geçersiz tarih reddi.
11. Migration tekrarında mevcut kaydın korunması.

npm run build başarılı; bu repoda build JavaScript syntax check komutudur, UI bundle üretimi değildir.
Tam npm test sonucu: 111 test; 109 başarılı, 0 başarısız, 2 atlandı (yaklaşık 71 saniye). Atlanan testler başarılı sayılmadı. Bu sonuç yeni modüllerin henüz yazılmamış uçtan uca senaryolarını kapsamaz.
Yeni dosyaların node --check kontrolleri de başarılı.
Ayrı lint/typecheck scripti tanımlı değil; bunlar yapılmış sayılmadı.
PostgreSQL gerçek eşzamanlı işlem/performans ve kullanıcı yetkili endpoint testleri henüz yok.
Servis iç backend bileşeni; oturumsuz kullanılabilecek yeni HTTP endpoint açılmadı.

## Sonraki aşamalar

1. Ön analiz: tamamlandı (canlı sistem/platform sınırları yukarıda).
2. Finans DB/ledger: ilk temel ve izole testler eklendi; üretim geçişi/açılış bakiyesi henüz yok.
3. Kurye dönem/hakediş: yapılmadı.
4. İşletme cari/tahsilat: iş akışına bağlanmadı.
5–7. Admin/kurye/restoran finans UI: yapılmadı.
8–10. SQL rapor servisleri ve üç panel: yapılmadı.
11–14. Merkezi bildirim DB/realtime/push/UI: yapılmadı.
15–17. Tam entegrasyon/güvenlik/performans: yapılmadı; yalnız temel testler mevcut.

### Üretim geçişinden önce netleşmesi gereken mali karar

Geçmiş kayıtlar yeni cari deftere otomatik aktarılacaksa gerçek açılış bakiyeleri ve güvenilir geçmiş fiyat kaynağı gereklidir. Bunlar doğrulanmadan geçmiş borç/alacak üretilemez.
Seçenekler:
- Belirlenen geçiş tarihinden itibaren yeni kayıtlar; eski hesaplar ayrı, doğrulanmış açılış hareketi sonradan.
- Geçmişin onaylı fiyat/bakiye kaynağı üzerinden kontrollü aktarımı.

Bu karar verilmeden mevcut işletmelere yeni hesaplanmış geçmiş borç yüklenmeyecek.
