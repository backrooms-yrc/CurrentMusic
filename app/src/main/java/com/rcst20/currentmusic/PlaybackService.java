package com.rcst20.currentmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** 播放前台服务：媒体通知 + 部分唤醒锁，保障 WebView 音频后台持续播放。 */
public class PlaybackService extends Service {

    private static final String CHANNEL_ID = "currentmusic_playback";
    private static final int NOTI_ID = 100;
    private PowerManager.WakeLock wl;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台播放",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("保障音乐后台持续播放");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification n = b.setContentTitle("CurrentMusic")
                .setContentText("正在后台播放音乐")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_LOW)
                .build();
        startForeground(NOTI_ID, n);
        if (wl == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CurrentMusic:playback");
            wl.setReferenceCounted(false);
        }
        if (!wl.isHeld()) wl.acquire(4 * 60 * 60 * 1000L); // 单次最长 4 小时，防止泄漏
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wl != null && wl.isHeld()) wl.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
