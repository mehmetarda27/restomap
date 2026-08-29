# RESTOMAP Chrome Extension

## Kurulum

1. Chrome'da `chrome://extensions` ac.
2. `Developer Mode` secenegini aktif et.
3. `Load unpacked` butonuna bas.
4. Bu klasoru sec:
   - `C:\Users\LENOVO\Documents\Codex\2026-04-19-kanka-paket-takip-uygulamas-yapacaz-kuriyelere\chrome-extension`

## Kullanim

1. Restoran paneline giris yap.
2. `Extension Token Kopyala` ile token'i al.
3. Getir, Trendyol, Yemeksepeti veya Migros panelini ac.
4. Extension popup'ta `Backend URL` ve `Restaurant Token` gir.
5. `Otomatik Izleme`yi ac.
6. Siparis platformda `kabul edildi`, `onaylandi`, `hazirlaniyor`, `accepted`, `confirmed`, `preparing`, `approved` veya `in preparation` durumuna gectiginde Delivera'ya otomatik duser.
7. Ayni siparis tekrar gonderilmez.
8. Manuel gonderme ve `Sadece Kopyala` fallback olarak durur.

## Otomatik Izleme Kurallari

- Otomatik izleme sadece desteklenen platform URL'lerinde baslar:
  - `getir`
  - `trendyol`
  - `yemeksepeti`
  - `migros`
- Backend URL ve token yoksa watcher baslamaz.
- Sadece kabul/onay/hazirlaniyor sinyali olan siparisler gonderilir.
- Sadece `yeni siparis`, `new order`, `siparis geldi`, `order received`, `pending`, `bekliyor` gibi bildirim metinleri otomatik gonderim baslatmaz.
- Status label veya durum alanlari once okunur, bulunamazsa sayfa metninden analiz yapilir.
- Otomatik mod hata verirse clipboard fallback yapilmaz; hata popup'ta gosterilir.

## Minimum Gonderim Sartlari

Asagidaki kombinasyonlardan en az biri varsa siparis aday kabul edilir:

- Telefon + tutar
- Telefon + adres
- Siparis no + tutar
- Siparis no + adres

## Duplicate Koruma

- Otomatik mod unique key sirasi:
  1. Siparis no / order id / teslimat no
  2. Telefon + tutar + normalize edilmis adresin ilk 60 karakteri
  3. Telefon + adresin ilk 60 karakteri
  4. Musteri adi + tutar + adresin ilk 60 karakteri
- Bunlar yoksa otomatik gonderim yapilmaz.
- `rawText` hash yalnizca manuel gonderimde son care olarak kullanilir.

## Popup Alanlari

- Otomatik Izleme Ac/Kapat
- Algilanan platform
- Son algilanan siparis ozeti
- Son gonderim durumu
- Son hata mesaji
- Gonderilen siparis sayisi
- Duplicate engellenen siparis sayisi

## Fallback

- Manuel gonderimde API basarisiz olursa extension siparis metnini otomatik clipboard'a kopyalar.
- Sonra Delivera restoran panelindeki `Hizli Siparis Yapistir` alanina yapistirabilirsin.
- `Sadece Kopyala` her sayfada calismaya devam eder.
