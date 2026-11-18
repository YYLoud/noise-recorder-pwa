package com.noiserecorder.evidence;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

public class NoiseMonitorForegroundService extends Service {

    public static final String CHANNEL_ID = "noise_recorder_monitor";
    public static final int NOTIFICATION_ID = 7001;

    public static final String ACTION_START = "com.noiserecorder.evidence.action.START_MONITOR";
    public static final String ACTION_UPDATE = "com.noiserecorder.evidence.action.UPDATE_MONITOR";
    public static final String ACTION_STOP = "com.noiserecorder.evidence.action.STOP_MONITOR";

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    // Safety cap: release CPU WakeLock automatically after 10 hours even if app process stalls
    private static final long MAX_WAKELOCK_DURATION_MS = 10L * 60L * 60L * 1000L;

    private PowerManager.WakeLock cpuWakeLock;

    public static void start(Context context, String title, String body) {
        Intent intent = new Intent(context, NoiseMonitorForegroundService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_BODY, body);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void update(Context context, String title, String body) {
        Intent intent = new Intent(context, NoiseMonitorForegroundService.class);
        intent.setAction(ACTION_UPDATE);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_BODY, body);
        try {
            context.startService(intent);
        } catch (IllegalStateException ignored) {
            // App may not allow background start; ignore transient notification update
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, NoiseMonitorForegroundService.class);
        intent.setAction(ACTION_STOP);
        try {
            context.stopService(intent);
        } catch (Exception ignored) {
            // Ignore if already stopped
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            releaseCpuWakeLock();
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }

        String title = intent != null && intent.hasExtra(EXTRA_TITLE)
            ? intent.getStringExtra(EXTRA_TITLE)
            : "🔴 噪音記錄器・正在蒐證監測中";
        String body = intent != null && intent.hasExtra(EXTRA_BODY)
            ? intent.getStringExtra(EXTRA_BODY)
            : "低功耗防休眠與 10% 低電量保護已啟動";

        Notification notification = buildNotification(title, body);

        if (ACTION_UPDATE.equals(action)) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, notification);
            }
        } else {
            startForegroundCompat(notification);
            acquireCpuWakeLock();
        }

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        releaseCpuWakeLock();
        stopForegroundCompat();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseCpuWakeLock();
        stopForegroundCompat();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "噪音蒐證監測守護服務",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("確保長時間夜間錄影與突發巨響偵測不被系統強制暫停");
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String title, String body) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pendingIntent)
            .build();
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int fgsType = 0;
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                fgsType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                fgsType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            if (fgsType != 0) {
                try {
                    startForeground(NOTIFICATION_ID, notification, fgsType);
                    return;
                } catch (Throwable ignored) {
                    // Fallback below if OS rejects typed foreground start
                }
            }
        }
        startForeground(NOTIFICATION_ID, notification);
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void acquireCpuWakeLock() {
        if (cpuWakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                cpuWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NoiseRecorder::CpuWakeLock");
                cpuWakeLock.setReferenceCounted(false);
            }
        }
        if (cpuWakeLock != null && !cpuWakeLock.isHeld()) {
            try {
                cpuWakeLock.acquire(MAX_WAKELOCK_DURATION_MS);
            } catch (Exception ignored) {
                // Ignore wake lock failures on restricted devices
            }
        }
    }

    private void releaseCpuWakeLock() {
        if (cpuWakeLock != null && cpuWakeLock.isHeld()) {
            try {
                cpuWakeLock.release();
            } catch (Exception ignored) {
                // Ignore double release
            }
        }
    }
}
