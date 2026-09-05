package com.restomap.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.URLUtil;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private static final String COURIER_URL = "https://restomap.com.tr/";
    private static final String PRIVACY_URL = "https://restomap.com.tr/privacy.html";
    private static final String NOTIFICATION_CHANNEL_ID = "restomap_critical_packages";
    private static final int LOCATION_PERMISSION_REQUEST = 4101;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4102;
    private static final int BACKGROUND_LOCATION_PERMISSION_REQUEST = 4103;

    private WebView webView;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean offlinePageVisible;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = getBridge().getWebView();
        configureWebView(webView);
        createNotificationChannel();
        webView.addJavascriptInterface(new NotificationBridge(this), "DeliveraNativeNotifications");
        webView.addJavascriptInterface(new NativeAppBridge(this), "DeliveraNativeApp");
        webView.setWebViewClient(new DeliveraWebViewClient(getBridge(), this));
        configureDownloads(webView);
        configureBackNavigation();
        monitorConnectivity();
        requestRuntimePermissions();

        if (!isOnline()) {
            loadOfflinePage();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " RESTOMAP-Android/1.2");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager.getInstance().setAcceptCookie(true);
    }

    private void configureDownloads(WebView view) {
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri uri;
            try {
                uri = Uri.parse(url);
            } catch (RuntimeException error) {
                Toast.makeText(this, "Dosya bağlantısı geçersiz.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!isTrustedDeliveraUri(uri) || !"https".equalsIgnoreCase(uri.getScheme())) {
                openExternal(uri);
                return;
            }
            try {
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setTitle(fileName)
                    .setDescription("RESTOMAP dosyası indiriliyor")
                    .setMimeType(mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName)
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(true);
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isEmpty()) request.addRequestHeader("Cookie", cookies);
                if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);
                DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (manager == null) throw new IllegalStateException("Download manager unavailable");
                manager.enqueue(request);
                Toast.makeText(this, "İndirme başlatıldı: " + fileName, Toast.LENGTH_LONG).show();
            } catch (RuntimeException error) {
                openExternal(uri);
            }
        });
    }

    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }

    private void monitorConnectivity() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                runOnUiThread(() -> {
                    if (offlinePageVisible && webView != null) {
                        offlinePageVisible = false;
                        webView.loadUrl(COURIER_URL);
                    }
                });
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
            networkCallback = null;
        }
    }

    @Override
    public void onDestroy() {
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {}
        }
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri uri = intent == null ? null : intent.getData();
        if (uri != null && isTrustedDeliveraUri(uri) && webView != null) {
            webView.loadUrl(uri.toString());
        }
    }

    private void requestRuntimePermissions() {
        if (
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            if (!getPreferences(MODE_PRIVATE).getBoolean("location_disclosure_accepted", false)) {
                showLocationDisclosure();
                return;
            }
            ActivityCompat.requestPermissions(
                this,
                new String[] { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
                LOCATION_PERMISSION_REQUEST
            );
            return;
        }

        requestNotificationPermission();
        requestBackgroundLocationPermission();
    }

    private void showLocationDisclosure() {
        new AlertDialog.Builder(this)
            .setTitle("Konum verilerinin kullanımı")
            .setMessage("RESTOMAP, vardiyanız açıkken paket ataması, canlı kurye takibi, rota ve teslimat güvenliği özelliklerini sağlamak için hassas konum verinizi toplar ve operasyon merkezine iletir. Konum, uygulama kapalıyken veya kullanımda değilken de arka planda işlenebilir. Vardiyanız kapalıyken konum gönderilmez ve konum verisi reklam amacıyla kullanılmaz.")
            .setNeutralButton("Gizlilik Politikası", (dialog, which) -> openExternal(Uri.parse(PRIVACY_URL)))
            .setNegativeButton("Şimdi değil", (dialog, which) -> requestNotificationPermission())
            .setPositiveButton("Kabul et ve devam et", (dialog, which) -> {
                getPreferences(MODE_PRIVATE).edit().putBoolean("location_disclosure_accepted", true).apply();
                requestRuntimePermissions();
            })
            .setCancelable(false)
            .show();
    }

    private void requestNotificationPermission() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private void requestBackgroundLocationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        if (getPreferences(MODE_PRIVATE).getBoolean("background_location_prompted", false)) {
            return;
        }
        getPreferences(MODE_PRIVATE).edit().putBoolean("background_location_prompted", true).apply();
        new AlertDialog.Builder(this)
            .setTitle("Arka planda canlı konum")
            .setMessage("RESTOMAP, vardiyanız açıkken uygulama ekranda olmasa bile dağıtım konumunuzu operasyon merkezine iletir. Bu özellik paket ataması, canlı kurye takibi ve teslimat güvenliği için gereklidir. Vardiyanız kapalıyken konum gönderilmez.")
            .setNegativeButton("Daha sonra", null)
            .setPositiveButton("Devam et", (dialog, which) -> {
                if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
                    ActivityCompat.requestPermissions(
                        this,
                        new String[] { Manifest.permission.ACCESS_BACKGROUND_LOCATION },
                        BACKGROUND_LOCATION_PERMISSION_REQUEST
                    );
                } else {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                }
            })
            .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == LOCATION_PERMISSION_REQUEST && !hasAnyGrantedPermission(grantResults)) {
            Toast
                .makeText(this, "Konum izni kapali. Mesai, GPS ve rota ozellikleri icin konum iznini acin.", Toast.LENGTH_LONG)
                .show();
            requestNotificationPermission();
        } else if (requestCode == LOCATION_PERMISSION_REQUEST) {
            requestNotificationPermission();
            requestBackgroundLocationPermission();
        } else if (requestCode == BACKGROUND_LOCATION_PERMISSION_REQUEST && !hasAnyGrantedPermission(grantResults)) {
            Toast.makeText(this, "Arka plan konumu kapalı. Ekran kapalıyken canlı takip sınırlanabilir.", Toast.LENGTH_LONG).show();
        }
    }

    private boolean hasAnyGrantedPermission(int[] grantResults) {
        for (int result : grantResults) {
            if (result == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
        }
        return false;
    }

    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) {
            return false;
        }
        Network network = manager.getActiveNetwork();
        if (network == null) {
            return false;
        }
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return (
            capabilities != null &&
            (
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            )
        );
    }

    private boolean isTrustedCourierPage() {
        if (webView == null || webView.getUrl() == null) {
            return false;
        }
        Uri uri = Uri.parse(webView.getUrl());
        String host = uri.getHost();
        return isTrustedDeliveraUri(uri);
    }

    private static boolean isTrustedDeliveraUri(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        return host != null &&
            (host.equalsIgnoreCase("restomap.onrender.com") || host.equalsIgnoreCase("restomap.com.tr") || host.toLowerCase(Locale.ROOT).endsWith(".restomap.com.tr"));
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "Bu bağlantı açılamadı.", Toast.LENGTH_LONG).show();
        }
    }

    private void loadOfflinePage() {
        if (webView == null) {
            return;
        }
        offlinePageVisible = true;
        webView.loadDataWithBaseURL(COURIER_URL, offlineHtml(), "text/html", "UTF-8", null);
    }

    private static String offlineHtml() {
        return (
            "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"delivera-offline\" content=\"1\">" +
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">" +
            "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07110d;color:#f6fff9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
            ".card{width:min(86vw,380px);padding:28px;border:1px solid rgba(255,255,255,.12);border-radius:28px;background:linear-gradient(160deg,rgba(255,255,255,.10),rgba(255,255,255,.03));box-shadow:0 24px 80px rgba(0,0,0,.42)}" +
            ".mark{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;background:#21d07a;color:#07110d;font-size:32px;font-weight:900;margin-bottom:18px}" +
            "h1{font-size:22px;margin:0 0 10px}p{color:#b9cfc4;line-height:1.5;margin:0 0 22px}.btn{width:100%;border:0;border-radius:18px;background:#21d07a;color:#07110d;font-weight:800;font-size:16px;padding:15px}</style>" +
            "</head><body><main class=\"card\"><div class=\"mark\">R</div><h1>RESTOMAP</h1>" +
            "<p>\u0130nternet ba\u011flant\u0131s\u0131 yok. L\u00fctfen ba\u011flant\u0131n\u0131z\u0131 kontrol edin.</p>" +
            "<button class=\"btn\" onclick=\"location.href='" + COURIER_URL + "'\">Tekrar dene</button></main></body></html>"
        );
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "RESTOMAP",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Kurye paket ve durum bildirimleri");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.deleteNotificationChannel("delivera_critical_packages");
            manager.createNotificationChannel(channel);
        }
    }

    private static class DeliveraWebViewClient extends BridgeWebViewClient {
        private final Bridge bridge;
        private final MainActivity activity;

        DeliveraWebViewClient(Bridge bridge, MainActivity activity) {
            super(bridge);
            this.bridge = bridge;
            this.activity = activity;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url == null) {
                return true;
            }
            if (isMapsUrl(url)) {
                openMaps(url);
                return true;
            }
            if (isAllowedInAppUrl(url)) {
                return false;
            }
            if ("http".equals(url.getScheme()) || "https".equals(url.getScheme())) {
                openExternalBrowser(url);
                return true;
            }
            return bridge.launchIntent(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                activity.loadOfflinePage();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            view.evaluateJavascript("Boolean(document.querySelector('meta[name=\\\"delivera-offline\\\"]'))", (value) -> activity.offlinePageVisible = "true".equals(value));
            injectNotificationBridge(view);
            injectNativeSessionBridge(view);
            injectMobileLayout(view);
        }

        private void injectMobileLayout(WebView view) {
            view.evaluateJavascript(
                "(function(){" +
                "if(window.__restomapMobileLayout)return;window.__restomapMobileLayout=true;" +
                "var style=document.createElement('style');style.id='restomap-native-mobile-style';" +
                "style.textContent='" +
                "html.restomap-native-app,html.restomap-native-app body{max-width:100vw!important;}" +
                "html.restomap-native-app body.restomap-auth-visible{min-width:0!important;width:100%!important;max-width:100vw!important;overflow:hidden!important;}" +
                "html.restomap-native-app .delivera-auth-shell{width:100vw!important;max-width:100vw!important;overflow-x:hidden!important;}" +
                "@media(max-width:760px){" +
                "html.restomap-native-app body.restomap-native-panel{min-width:0!important;width:100vw!important;max-width:100vw!important;overflow-x:hidden!important;}" +
                "body.restomap-native-panel main{margin-left:0!important;min-width:0!important;width:100vw!important;max-width:100vw!important;overflow-x:auto!important;}" +
                "body.restomap-native-panel aside{position:fixed!important;inset:0 auto 0 0!important;width:min(84vw,320px)!important;max-width:320px!important;height:100dvh!important;transform:translateX(-105%)!important;transition:transform .2s ease!important;z-index:2147482000!important;overflow-y:auto!important;}" +
                "body.restomap-native-panel.restomap-mobile-menu-open aside{transform:translateX(0)!important;}" +
                "body.restomap-native-panel main>header{padding-left:64px!important;max-width:100vw!important;overflow-x:auto!important;}" +
                "body.restomap-native-panel main>div,body.restomap-native-panel main>section{min-width:0!important;max-width:100vw!important;}" +
                ".restomap-native-menu{display:flex!important;position:fixed!important;left:12px!important;top:12px!important;width:42px!important;height:42px!important;border:0!important;border-radius:12px!important;align-items:center!important;justify-content:center!important;background:#0b4bc0!important;color:#fff!important;font-size:24px!important;line-height:1!important;box-shadow:0 6px 20px rgba(0,0,0,.25)!important;z-index:2147482500!important;}" +
                ".restomap-native-menu-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147481500;}" +
                "body.restomap-mobile-menu-open .restomap-native-menu-backdrop{display:block;}" +
                "body.restomap-auth-visible .restomap-native-menu,body.restomap-auth-visible .restomap-native-menu-backdrop{display:none!important;}" +
                "}" +
                "';document.head.appendChild(style);document.documentElement.classList.add('restomap-native-app');" +
                "function closeMenu(){document.body&&document.body.classList.remove('restomap-mobile-menu-open');}" +
                "function sync(){if(!document.body)return;" +
                "var panel=/\\/(admin|restaurant)\\.html$/i.test(location.pathname);" +
                "var auth=!!document.querySelector('.delivera-auth-shell');" +
                "document.body.classList.toggle('restomap-native-panel',panel);" +
                "document.body.classList.toggle('restomap-auth-visible',auth);" +
                "if(!panel)return;" +
                "var button=document.querySelector('.restomap-native-menu');" +
                "if(!button){button=document.createElement('button');button.type='button';button.className='restomap-native-menu';button.setAttribute('aria-label','Menüyü aç');button.textContent='☰';button.onclick=function(){document.body.classList.toggle('restomap-mobile-menu-open');};document.body.appendChild(button);}" +
                "var backdrop=document.querySelector('.restomap-native-menu-backdrop');" +
                "if(!backdrop){backdrop=document.createElement('div');backdrop.className='restomap-native-menu-backdrop';backdrop.onclick=closeMenu;document.body.appendChild(backdrop);}" +
                "document.querySelectorAll('aside a,aside button').forEach(function(el){if(el.dataset.restomapMenuBound)return;el.dataset.restomapMenuBound='1';el.addEventListener('click',closeMenu);});" +
                "if(auth)closeMenu();" +
                "}" +
                "sync();new MutationObserver(sync).observe(document.documentElement,{childList:true,subtree:true});" +
                "window.addEventListener('resize',sync);" +
                "})();",
                null
            );
        }

        private void injectNotificationBridge(WebView view) {
            view.evaluateJavascript(
                "(function(){if(window.__deliveraNativeNotificationBridge)return;" +
                "if(!window.DeliveraNativeNotifications)return;" +
                "window.__deliveraNativeNotificationBridge=true;" +
                "function NativeNotification(title,options){" +
                "options=options||{};" +
                "window.DeliveraNativeNotifications.show(String(title||'RESTOMAP'),String(options.body||''));" +
                "}" +
                "NativeNotification.permission=window.DeliveraNativeNotifications.areEnabled()?'granted':'default';" +
                "NativeNotification.requestPermission=function(){" +
                "NativeNotification.permission=window.DeliveraNativeNotifications.areEnabled()?'granted':'denied';" +
                "return Promise.resolve(NativeNotification.permission);" +
                "};" +
                "window.Notification=NativeNotification;" +
                "})();",
                null
            );
        }

        private void injectNativeSessionBridge(WebView view) {
            view.evaluateJavascript(
                "(function(){if(window.__deliveraNativeSessionBridge)return;" +
                "if(!window.DeliveraNativeApp)return;" +
                "window.__deliveraNativeSessionBridge=true;" +
                "function sync(){try{" +
                "var token=localStorage.getItem('kuryeTakipCourierToken')||'';" +
                "var refresh=localStorage.getItem('kuryeTakipCourierRefreshToken')||'';" +
                "window.DeliveraNativeApp.syncSession(token,refresh);" +
                "}catch(e){}}" +
                "sync();setInterval(sync,4000);" +
                "window.addEventListener('storage',sync);" +
                "document.addEventListener('visibilitychange',sync);" +
                "})();",
                null
            );
        }

        private boolean isAllowedInAppUrl(Uri uri) {
            String host = normalizeHost(uri.getHost());
            if (host == null) {
                return false;
            }
            return (
                host.equals("restomap.onrender.com") ||
                host.equals("restomap.com.tr") ||
                host.endsWith(".restomap.com.tr") ||
                host.endsWith(".google.com") ||
                host.equals("google.com") ||
                host.endsWith(".google.com.tr") ||
                host.equals("google.com.tr") ||
                host.endsWith(".googleapis.com") ||
                host.equals("googleapis.com") ||
                host.endsWith(".gstatic.com") ||
                host.equals("gstatic.com") ||
                host.endsWith(".googleusercontent.com") ||
                host.equals("googleusercontent.com") ||
                host.endsWith(".firebaseio.com") ||
                host.equals("firebaseio.com") ||
                host.endsWith(".firebaseapp.com") ||
                host.equals("firebaseapp.com")
            );
        }

        private boolean isMapsUrl(Uri uri) {
            String host = normalizeHost(uri.getHost());
            String path = uri.getPath() == null ? "" : uri.getPath();
            if ("geo".equals(uri.getScheme())) {
                return true;
            }
            return (
                host != null &&
                (
                    host.equals("maps.google.com") ||
                    host.equals("www.google.com") && path.startsWith("/maps") ||
                    host.equals("google.com") && path.startsWith("/maps") ||
                    host.endsWith(".google.com") && path.startsWith("/maps")
                )
            );
        }

        private String normalizeHost(String host) {
            return host == null ? null : host.toLowerCase(Locale.ROOT);
        }

        private void openMaps(Uri uri) {
            Intent mapsIntent = new Intent(Intent.ACTION_VIEW, uri);
            mapsIntent.setPackage("com.google.android.apps.maps");
            try {
                activity.startActivity(mapsIntent);
            } catch (ActivityNotFoundException missingMaps) {
                openExternalBrowser(uri);
            }
        }

        private void openExternalBrowser(Uri uri) {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                Toast.makeText(activity, "Bu baglanti acilamadi.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private static class NotificationBridge {
        private final MainActivity activity;

        NotificationBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public boolean areEnabled() {
            return NotificationManagerCompat.from(activity).areNotificationsEnabled();
        }

        @JavascriptInterface
        public void show(String title, String body) {
            if (!areEnabled() || !activity.isTrustedCourierPage()) {
                return;
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                return;
            }
            Intent intent = new Intent(activity, MainActivity.class);
            intent.setAction(Intent.ACTION_VIEW);
            intent.setData(Uri.parse(COURIER_URL));
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            PendingIntent pendingIntent = PendingIntent.getActivity(
                activity,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(activity, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_restomap_paket_monochrome)
                .setContentTitle(title == null || title.isEmpty() ? "RESTOMAP" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body == null ? "" : body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setVibrate(new long[] { 0, 350, 120, 350, 120, 700 })
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

            try {
                NotificationManagerCompat
                    .from(activity)
                    .notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), builder.build());
            } catch (SecurityException ignored) {
                // Permission can be revoked while the WebView is running.
            }
        }
    }

    private static class NativeAppBridge {
        private final MainActivity activity;

        NativeAppBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void setPushEnabled(boolean enabled) {
            activity.runOnUiThread(() -> {
                if (!activity.isTrustedCourierPage()) return;
                activity.getSharedPreferences(DeliveraCourierService.PREFS, MODE_PRIVATE)
                    .edit().putBoolean("fcm_enabled", enabled).apply();
            });
        }

        @JavascriptInterface
        public void syncSession(String accessToken, String refreshToken) {
            String token = accessToken == null ? "" : accessToken.trim();
            String refresh = refreshToken == null ? "" : refreshToken.trim();
            activity.runOnUiThread(() -> {
                if (!activity.isTrustedCourierPage()) {
                    return;
                }
                if (token.isEmpty()) {
                    activity.getSharedPreferences(DeliveraCourierService.PREFS, MODE_PRIVATE)
                        .edit()
                        .clear()
                        .apply();
                    DeliveraCourierService.stop(activity);
                    return;
                }
                activity.getSharedPreferences(DeliveraCourierService.PREFS, MODE_PRIVATE)
                    .edit()
                    .putString(DeliveraCourierService.KEY_ACCESS_TOKEN, token)
                    .putString(DeliveraCourierService.KEY_REFRESH_TOKEN, refresh)
                    .putBoolean(DeliveraCourierService.KEY_SERVICE_ENABLED, true)
                    .apply();
                try {
                    DeliveraCourierService.start(activity);
                } catch (RuntimeException error) {
                    Toast.makeText(activity, "Arka plan servisi başlatılamadı. Konum izinlerini kontrol edin.", Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
