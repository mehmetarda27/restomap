# RESTOMAP Mobile App

`RESTOMAP`, yönetici, restoran ve kurye panellerini tek giriş ekranından açan Android WebView/Capacitor uygulamasıdır. Şu adresi yükler:

```text
https://restomap.com.tr/
```

## Kurulum

```bash
npm install
npm run build
npm run mobile:sync
```

Android Studio ile `android/` klasorunu acin. Ilk acilista Gradle senkronizasyonunun bitmesini bekleyin.

## APK Alma

Debug APK icin:

```bash
cd android
./gradlew assembleDebug
```

Windows PowerShell icin:

```powershell
cd android
.\gradlew.bat assembleDebug
```

APK yolu:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Release APK/AAB icin Android Studio'da `Build > Generate Signed Bundle / APK` menusu kullanilir. Keystore dosyasini repo icine koymayin.

Guncel uygulama surumu `1.1` (`versionCode 2`), hedef API seviyesi 36'dir. Google Play'e yeni uygulama yuklemesi APK ile degil, imzali Android App Bundle (`.aab`) ile yapilir. Test icin uretilen debug APK Play'e yuklenmemelidir.

## URL Degistirme

Ana URL `capacitor.config.ts` icindeki `courierUrl` sabitinden degistirilir.

Degisimden sonra:

```bash
npm run mobile:sync
```

Uygulama icinde sadece asagidaki domainler WebView'de calisir:

```text
restomap.onrender.com, restomap.com.tr ve alt domainleri
google.com ve alt domainleri
google.com.tr ve alt domainleri
googleapis.com
gstatic.com
googleusercontent.com
firebaseio.com
firebaseapp.com
```

Rastgele dis linkler uygulama icinde acilmaz; Android'in guvenli dis uygulama/tarayici akisi ile acilir.

## Logo Degistirme

RESTOMAP logosu Android ekran yogunluklarina uygun PNG launcher ikonlari olarak `android/app/src/main/res/mipmap-*` klasorlerinde bulunur. Bildirim cubugunda Android'in zorunlu tek renkli simgesi kullanilir:

```text
android/app/src/main/res/drawable/ic_restomap_paket_monochrome.xml
```

Adaptif launcher ikonlari:

```text
android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml
```

Splash gorselleri Capacitor tarafindan `android/app/src/main/res/drawable*/splash.png` olarak uretilir. Yeni splash/ikon seti icin Android Studio `Image Asset` araci veya Capacitor asset pipeline kullanilabilir.

## Konum Izni ve Arka Plan Servisi

Manifest izinleri:

```text
ACCESS_FINE_LOCATION
ACCESS_COARSE_LOCATION
ACCESS_BACKGROUND_LOCATION
FOREGROUND_SERVICE_LOCATION
ACCESS_NETWORK_STATE
INTERNET
```

Uygulama acilisinda konum izni istenir. Kurye oturum actiginda native foreground servis baslar; vardiya aktifken uygulama arka plana alinsa da GPS konumu `/api/courier/location` endpointine gondermeye devam eder. Android 11 ve uzerinde kullanici `Her zaman izin ver` secenegini uygulama ayarlarindan onaylar.

Konum izninden once uygulama icinde belirgin veri kullanimi aciklamasi gosterilir. Gizlilik politikasi hem bu aciklamadan hem de asagidaki herkese acik URL'den erisilebilir:

```text
https://restomap.onrender.com/privacy.html
```

Play Console'da arka plan konumu izin beyan formu, kisa ekran videosu, Data Safety formu ve gizlilik politikasi URL'si ayrica tamamlanmalidir.

## Bildirim Izni

Android 13 ve uzeri cihazlarda `POST_NOTIFICATIONS` izni uygulama acilisinda istenir.

Web paneli `Notification` API kullandiginda Android WebView icinde native bridge devreye girer ve bildirimi Android notification olarak gosterir. Foreground servis ayrica kurye calisma alanini arka planda kontrol eder; yeni paket veya kurye bildirimi geldiginde yuksek oncelikli Android bildirimi olusturur. Bildirime basinca uygulama kurye panelini acar.

Foreground servis calisirken uygulama arka planda da yeni paketleri kontrol eder. Kullanici uygulamayi Android ayarlarindan zorla durdurdugunda dahi uzaktan bildirim almak istenirse Firebase Cloud Messaging kurulumu gerekir. Hazirlik adimlari:

1. Firebase Console'da Android app olusturun.
2. Paket adı olarak `com.restomap.app` girin.
3. `google-services.json` dosyasini indirin.
4. Dosyayi `android/app/google-services.json` konumuna koyun.
5. Gerekli backend FCM bilgilerini production secret olarak tutun.

`.env.example` icindeki opsiyonel alanlar:

```text
FCM_PROJECT_ID=
FCM_VAPID_PUBLIC_KEY=
FCM_SERVICE_ACCOUNT_JSON=
```

FCM credentials repo icine commit edilmemelidir.

## Harita

Kurye panelindeki Google Maps linkleri Android'de once Google Maps uygulamasina gonderilir. Google Maps yuklu degilse cihazdaki tarayiciya duser.

Harita on izlemesi web panelde Google Maps Embed API ile calisir. API key:

```text
GOOGLE_MAPS_EMBED_API_KEY=
```

## Oturum Koruma

WebView'de JavaScript, DOM storage ve cookie destegi aciktir. Kurye login token/cookie/local storage verileri uygulama kapanip acildiginda korunur.

## WebView Uygulama Ozellikleri

- Android geri tusu ve geri hareketi WebView gecmisinde calisir.
- Harita, telefon ve harici web adresleri uygun Android uygulamasina guvenli sekilde yonlendirilir.
- HTML dosya alanlari sistem dosya secicisini ve istege bagli kamerayi acar.
- RESTOMAP alan adindaki indirmeler oturum cerezleri korunarak Android indirme yoneticisine aktarilir.
- Internet geri geldiginde ozel hata ekrani kurye panelini otomatik yeniden yukler.
- HTTPS disi karisik icerik engellenir ve WebView Safe Browsing aciktir.

## Baglanti Yok Ekrani

Internet yoksa uygulama su mesaji gosteren native WebView hata ekranina duser:

```text
Internet baglantisi yok. Lutfen baglantinizi kontrol edin.
```

Ekranda `Tekrar dene` butonu vardir. Render free instance uyanirken sayfa yuklenene kadar WebView baglanmaya devam eder.

## Sik Hata Cozumleri

`Android SDK not found`

Android Studio'yu acip SDK Manager'dan Android SDK ve platform tools kurun. `ANDROID_HOME` veya `ANDROID_SDK_ROOT` ortam degiskenini kontrol edin.

`Gradle build failed`

Android Studio Gradle sync ekranindaki ilk hataya bakin. Java surumu, Android Gradle Plugin ve SDK lisanslari en sik sebeplerdir.

`Konum calismiyor`

Cihaz ayarlarindan uygulama konum iznini `Precise` / `Hassas` olarak acin. Emulator kullaniliyorsa emulator location ayarlarindan test koordinati gonderin.

`Bildirim gelmiyor`

Android 13+ icin bildirim iznini kontrol edin. Native push icin Firebase kurulumu ve backend FCM gonderimi tamamlanmis olmalidir.

`Haritada Ac` tarayiciya dusuyor

Google Maps uygulamasi kurulu degilse beklenen davranis budur. Kuruluysa Android app defaults/varsayilan uygulama ayarlari kontrol edilmelidir.

## Test Listesi

- Android emulator veya gercek cihazda uygulama aciliyor.
- Splash screen gorunuyor ve kurye paneli yukleniyor.
- Kurye login mobilde calisiyor.
- Uygulama kapanip acilinca oturum korunuyor.
- Konum izni isteniyor ve hassas konum ile GPS ozellikleri calisiyor.
- Mesai baslatma/bitirme konum hatasi vermiyor.
- Haritada Ac Google Maps uygulamasini, yoksa tarayiciyi aciyor.
- Bildirim izni isteniyor.
- Internet kapaliyken ozel hata ekrani ve `Tekrar dene` calisiyor.
- Android geri tusu WebView gecmisinde geri gidiyor, gecmis yoksa uygulamadan cikiyor.
