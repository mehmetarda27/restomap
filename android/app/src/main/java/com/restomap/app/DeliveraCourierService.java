package com.restomap.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public class DeliveraCourierService extends Service implements LocationListener {
    public static final String PREFS = "delivera_mobile_session";
    public static final String KEY_ACCESS_TOKEN = "access_token";
    public static final String KEY_REFRESH_TOKEN = "refresh_token";
    public static final String KEY_SERVICE_ENABLED = "service_enabled";

    private static final String API_ROOT = "https://restomap.com.tr";
    private static final String COURIER_URL = API_ROOT + "/courier.html";
    private static final String SERVICE_CHANNEL = "restomap_background_location";
    private static final String ALERT_CHANNEL = "restomap_critical_packages";
    private static final int SERVICE_NOTIFICATION_ID = 7201;
    private static final String KEY_SEEN_ASSIGNMENTS = "seen_assignment_keys";
    private static final long POLL_SECONDS = 20L;
    private static final long LOCATION_MIN_TIME_MS = 15_000L;
    private static final float LOCATION_MIN_DISTANCE_METERS = 8f;
    private static final long LOCATION_SEND_MIN_INTERVAL_MS = 25_000L;
    private static final long LAST_KNOWN_LOCATION_MAX_AGE_MS = 5 * 60_000L;
    private static final int MAX_PERSISTED_ASSIGNMENTS = 250;

    private final Object tokenLock = new Object();
    private final Set<String> seenNotificationIds = new HashSet<>();
    private final Set<String> seenAssignmentKeys = new HashSet<>();
    private ScheduledExecutorService scheduler;
    private LocationManager locationManager;
    private volatile boolean available;
    private volatile boolean firstWorkspaceLoaded;
    private volatile Location latestLocation;
    private volatile long lastLocationSentAtElapsedMs;

    public static void start(Context context) {
        Intent intent = new Intent(context, DeliveraCourierService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, DeliveraCourierService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(SERVICE_NOTIFICATION_ID, buildServiceNotification("Kurye sistemi bağlanıyor"));
        scheduler = Executors.newSingleThreadScheduledExecutor();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        seenAssignmentKeys.addAll(
            getSharedPreferences(PREFS, MODE_PRIVATE).getStringSet(KEY_SEEN_ASSIGNMENTS, new HashSet<>())
        );
        startLocationUpdatesIfPermitted();
        scheduler.scheduleWithFixedDelay(this::pollWorkspaceSafely, 0, POLL_SECONDS, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_SERVICE_ENABLED, false) || prefs.getString(KEY_ACCESS_TOKEN, "").isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (locationManager != null) {
            locationManager.removeUpdates(this);
        }
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startLocationUpdatesIfPermitted() {
        if (
            ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            updateServiceNotification("Konum izni bekleniyor");
            return;
        }
        try {
            Location newestLastKnown = null;
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                newestLastKnown = newerLocation(newestLastKnown, recentLastKnownLocation(locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)));
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    LOCATION_MIN_TIME_MS,
                    LOCATION_MIN_DISTANCE_METERS,
                    this
                );
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                newestLastKnown = newerLocation(newestLastKnown, recentLastKnownLocation(locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)));
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    LOCATION_MIN_TIME_MS,
                    LOCATION_MIN_DISTANCE_METERS,
                    this
                );
            }
            latestLocation = newerLocation(latestLocation, newestLastKnown);
        } catch (RuntimeException ignored) {
            updateServiceNotification("Konum servisi bekleniyor");
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null) {
            return;
        }
        Location current = latestLocation;
        if (current == null || location.getTime() >= current.getTime()) {
            latestLocation = location;
        }
        if (available && scheduler != null) {
            scheduler.execute(this::sendLatestLocationSafely);
        }
    }

    private Location newerLocation(Location first, Location second) {
        if (second == null) return first;
        if (first == null || second.getTime() >= first.getTime()) return second;
        return first;
    }

    private Location recentLastKnownLocation(Location location) {
        if (location == null) return null;
        long ageMs = System.currentTimeMillis() - location.getTime();
        return ageMs >= -60_000L && ageMs <= LAST_KNOWN_LOCATION_MAX_AGE_MS ? location : null;
    }

    @Override
    public void onProviderEnabled(String provider) {
        startLocationUpdatesIfPermitted();
    }

    @Override
    public void onProviderDisabled(String provider) {
        updateServiceNotification("GPS açılması bekleniyor");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onStatusChanged(String provider, int status, Bundle extras) {
        // Required by older Android versions.
    }

    private void pollWorkspaceSafely() {
        try {
            pollWorkspace();
        } catch (Exception ignored) {
            updateServiceNotification("Bağlantı yeniden deneniyor");
        }
    }

    private void pollWorkspace() throws Exception {
        String token = accessToken();
        if (token.isEmpty()) {
            stopSelf();
            return;
        }

        HttpResult result = request("GET", "/api/courier/me?limit=100&cursor=0", null, token);
        if (result.status == 401 && refreshAccessToken()) {
            result = request("GET", "/api/courier/me?limit=100&cursor=0", null, accessToken());
        }
        if (result.status < 200 || result.status >= 300) {
            throw new IllegalStateException("Workspace HTTP " + result.status);
        }

        JSONObject workspace = new JSONObject(result.body);
        JSONObject courier = workspace.optJSONObject("courier");
        available = courier != null && courier.optBoolean("available", false);
        processWorkspaceAlerts(workspace);
        if (available) {
            sendLatestLocationSafely();
        }
        updateServiceNotification(available ? "Vardiya aktif · canlı konum açık" : "Bildirimler açık · vardiya kapalı");
    }

    private void processWorkspaceAlerts(JSONObject workspace) {
        if (getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("fcm_enabled", false)) return;
        JSONArray notifications = workspace.optJSONArray("notifications");
        Set<String> currentNotificationIds = new HashSet<>();
        if (notifications != null) {
            for (int index = 0; index < notifications.length(); index++) {
                JSONObject item = notifications.optJSONObject(index);
                if (item == null) continue;
                String id = item.optString("id", "notification-" + index);
                String eventType = item.optString("eventType", "");
                currentNotificationIds.add(id);
                boolean assignmentDuplicate = "package-assigned".equals(eventType)
                    || "package-override".equals(eventType)
                    || "package-reassign".equals(eventType)
                    || "restaurant-confirmed".equals(eventType)
                    || "package-status".equals(eventType);
                if (firstWorkspaceLoaded && !assignmentDuplicate && !seenNotificationIds.contains(id)) {
                    showCriticalNotification("RESTOMAP", item.optString("message", "Yeni bildiriminiz var."), "notification-" + id);
                }
            }
        }

        JSONArray packages = workspace.optJSONArray("packages");
        Set<String> currentAssignmentKeys = new HashSet<>();
        if (packages != null) {
            for (int index = 0; index < packages.length(); index++) {
                JSONObject item = packages.optJSONObject(index);
                if (item == null || !"assigned".equalsIgnoreCase(item.optString("status"))) continue;
                String id = item.optString("id", "package-" + index);
                String key = id + ":" + item.optString("assignedAt", "");
                currentAssignmentKeys.add(key);
                if (!seenAssignmentKeys.contains(key)) {
                    String restaurant = item.optString("restaurantName", "Restoran");
                    String address = item.optString("customerAddress", item.optString("deliveryAddress", "Paket ayrıntısını açın"));
                    showCriticalNotification("Yeni paket düştü", restaurant + " · " + address, "package-" + id);
                    rememberAssignmentKey(key);
                }
            }
        }

        seenNotificationIds.clear();
        seenNotificationIds.addAll(currentNotificationIds);
        seenAssignmentKeys.addAll(currentAssignmentKeys);
        firstWorkspaceLoaded = true;
    }

    private void rememberAssignmentKey(String key) {
        seenAssignmentKeys.add(key);
        LinkedHashSet<String> bounded = new LinkedHashSet<>(seenAssignmentKeys);
        while (bounded.size() > MAX_PERSISTED_ASSIGNMENTS) {
            String oldest = bounded.iterator().next();
            bounded.remove(oldest);
        }
        seenAssignmentKeys.clear();
        seenAssignmentKeys.addAll(bounded);
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_SEEN_ASSIGNMENTS, new HashSet<>(bounded))
            .apply();
    }

    private void sendLatestLocationSafely() {
        if (!available) {
            return;
        }
        Location location = latestLocation;
        if (location == null) {
            return;
        }
        long nowElapsed = SystemClock.elapsedRealtime();
        if (lastLocationSentAtElapsedMs > 0 && nowElapsed - lastLocationSentAtElapsedMs < LOCATION_SEND_MIN_INTERVAL_MS) {
            return;
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("latitude", location.getLatitude());
            payload.put("longitude", location.getLongitude());
            payload.put("observedAt", location.getTime());
            payload.put("available", true);
            payload.put("locationOnly", true);
            HttpResult result = request("PATCH", "/api/courier/location", payload.toString(), accessToken());
            if (result.status == 401 && refreshAccessToken()) {
                result = request("PATCH", "/api/courier/location", payload.toString(), accessToken());
            }
            if (result.status >= 200 && result.status < 300) {
                lastLocationSentAtElapsedMs = nowElapsed;
            }
        } catch (Exception ignored) {
            // The next scheduled workspace/location cycle retries without interrupting the service.
        }
    }

    private boolean refreshAccessToken() {
        synchronized (tokenLock) {
            String refreshToken = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_REFRESH_TOKEN, "");
            if (refreshToken.isEmpty()) {
                return false;
            }
            try {
                JSONObject payload = new JSONObject();
                payload.put("refreshToken", refreshToken);
                HttpResult result = request("POST", "/api/courier/refresh", payload.toString(), "");
                if (result.status < 200 || result.status >= 300) {
                    return false;
                }
                JSONObject auth = new JSONObject(result.body);
                String token = auth.optString("token", auth.optString("accessToken", ""));
                String nextRefreshToken = auth.optString("refreshToken", refreshToken);
                if (token.isEmpty()) {
                    return false;
                }
                getSharedPreferences(PREFS, MODE_PRIVATE)
                    .edit()
                    .putString(KEY_ACCESS_TOKEN, token)
                    .putString(KEY_REFRESH_TOKEN, nextRefreshToken)
                    .apply();
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    private String accessToken() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_ACCESS_TOKEN, "");
    }

    private HttpResult request(String method, String path, String body, String bearerToken) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(API_ROOT + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(12_000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "RESTOMAP-Android/1.2");
        if (bearerToken != null && !bearerToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
        }
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream();
        StringBuilder response = new StringBuilder();
        if (stream != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) response.append(line);
            }
        }
        connection.disconnect();
        return new HttpResult(status, response.toString());
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.deleteNotificationChannel("delivera_background_location");
        manager.deleteNotificationChannel("delivera_critical_packages");

        NotificationChannel serviceChannel = new NotificationChannel(
            SERVICE_CHANNEL,
            "RESTOMAP arka plan konumu",
            NotificationManager.IMPORTANCE_LOW
        );
        serviceChannel.setDescription("Vardiya sırasında canlı konum ve paket bağlantısı");
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel alertChannel = new NotificationChannel(
            ALERT_CHANNEL,
            "Kritik paket bildirimleri",
            NotificationManager.IMPORTANCE_HIGH
        );
        alertChannel.setDescription("Yeni paket, atama ve operasyon bildirimleri");
        alertChannel.enableVibration(true);
        alertChannel.setVibrationPattern(new long[] { 0, 350, 120, 350, 120, 700 });
        manager.createNotificationChannel(alertChannel);
    }

    private Notification buildServiceNotification(String text) {
        return new NotificationCompat.Builder(this, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_restomap_paket_monochrome)
            .setContentTitle("RESTOMAP aktif")
            .setContentText(text)
            .setContentIntent(appPendingIntent("service"))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void updateServiceNotification(String text) {
        if (!canPostNotifications()) return;
        try {
            NotificationManagerCompat.from(this).notify(SERVICE_NOTIFICATION_ID, buildServiceNotification(text));
        } catch (SecurityException ignored) {
            // Permission can be revoked while the foreground service is active.
        }
    }

    private void showCriticalNotification(String title, String body, String tag) {
        if (!canPostNotifications() || !NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        Notification notification = new NotificationCompat.Builder(this, ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_restomap_paket_monochrome)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(appPendingIntent(tag))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVibrate(new long[] { 0, 350, 120, 350, 120, 700 })
            .build();
        try {
            NotificationManagerCompat.from(this).notify(tag, tag.hashCode(), notification);
        } catch (SecurityException ignored) {
            // Permission can be revoked while the foreground service is active.
        }
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private PendingIntent appPendingIntent(String tag) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(COURIER_URL));
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            tag.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static final class HttpResult {
        final int status;
        final String body;

        HttpResult(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }
}
