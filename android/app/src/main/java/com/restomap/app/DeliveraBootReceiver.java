package com.restomap.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public class DeliveraBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(DeliveraCourierService.PREFS, Context.MODE_PRIVATE);
        if (
            prefs.getBoolean(DeliveraCourierService.KEY_SERVICE_ENABLED, false) &&
            !prefs.getString(DeliveraCourierService.KEY_ACCESS_TOKEN, "").isEmpty()
        ) {
            try {
                DeliveraCourierService.start(context);
            } catch (RuntimeException ignored) {
                // New Android versions can defer location foreground services after boot.
                // Opening RESTOMAP restarts it immediately.
            }
        }
    }
}
