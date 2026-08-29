# RESTOMAP Operations

## Hızlı Kontrol

1. `GET /health`
2. Admin login
3. Restoran login
4. Kurye login
5. Manuel paket olustur
6. Webhook siparisi dusur
7. Admin panelden waiting / assigned / busy akisini kontrol et

## Operasyon Kurallari

- Bir kurye ayni anda en fazla 1 aktif paket tasir.
- Aktif paketler:
  - `assigned`
  - `accepted_by_courier`
  - `on_route`
- Waiting siparisler otomatik retry sweep ile tekrar denenir.
- Admin override sadece online ve musait kuriyeye yapilir.

## Panel Kullanimi

Restoran:
- kendi siparislerini gorur
- manuel paket ekler
- platform hesabini baglar

Admin:
- aktif siparisleri gorur
- waiting siparisleri ayri izler
- override, unassign, reassign yapar

Kurye:
- sadece kendi atanmis islerini gorur
- durum gunceller
- konum yollar

## Log Dosyalari

- `logs/webhooks.log`
- `logs/password-resets.log`
- `logs/admin-bootstrap.txt`

## Ornek Sorun Yorumlama

- `lastAssignmentError = uygun kurye yok`
  zone veya online kurye yok
- `lastAssignmentError = tum kuryeler busy`
  zone icindeki online kuryelerin aktif isi dolu
- `lastAssignmentError = tenant uyusmuyor`
  veri veya kayit tutarsizligi var
