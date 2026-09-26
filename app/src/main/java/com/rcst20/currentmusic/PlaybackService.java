package com.rcst20.currentmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 播放前台服务：MediaStyle 媒体通知（歌名/歌手/封面/传输控制）+ 部分唤醒锁。
 *
 * 通知与蓝牙（AVRCP）共用同一个框架 MediaSession：
 *  - 元数据（标题/歌手/专辑/时长/封面）→ 通知栏与蓝牙设备同步显示
 *  - PlaybackState（播放/暂停/位置）→ 系统媒体控制与 AVRCP 进度
 * 播放动作（通知按钮/蓝牙/耳机线控）经 MediaSession 回调转发回 WebView 播放器。
 */
public class PlaybackService extends Service {

    private static final String CHANNEL_ID = "currentmusic_playback";
    private static final int NOTI_ID = 100;
    static final String ACTION_PLAY = "cm.action.PLAY";
    static final String ACTION_PAUSE = "cm.action.PAUSE";
    static final String ACTION_NEXT = "cm.action.NEXT";
    static final String ACTION_PREV = "cm.action.PREV";

    private PowerManager.WakeLock wl;
    private MediaSession ms;
    private final ExecutorService artEx = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    // 当前媒体状态（服务未运行时桥调用先落静态字段，启动后首次通知即带上）
    private String title = "CurrentMusic", artist = "", album = "";
    private long durationMs = 0;
    private boolean playing = false;
    private long positionMs = 0;
    private Bitmap art;
    private String artUrl = "";

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        title = pTitle; artist = pArtist; album = pAlbum; durationMs = pDur;
        playing = pPlaying; positionMs = pPos;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台播放",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("正在播放的媒体信息与控制");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        ms = new MediaSession(this, "CurrentMusic");
        ms.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.runJs("window.__cmPlayer&&window.__cmPlayer.player.play()"); }
            @Override public void onPause() { MainActivity.runJs("window.__cmPlayer&&window.__cmPlayer.player.pause()"); }
            @Override public void onSkipToNext() { MainActivity.runJs("window.__cmPlayer&&window.__cmPlayer.player.next()"); }
            @Override public void onSkipToPrevious() { MainActivity.runJs("window.__cmPlayer&&window.__cmPlayer.player.prev()"); }
        });
        ms.setActive(true);
        // 恢复暂存封面（异步取图；首次 startForeground 先出文字通知，图到后随状态刷新带上）
        artUrl = pPic;
        if (!pPic.isEmpty()) {
            final String u = pPic;
            artEx.execute(() -> {
                Bitmap b = fetchArt(u);
                if (b != null && u.equals(artUrl)) art = b;
            });
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent != null ? intent.getAction() : null;
        if (act != null && !act.isEmpty() && ms != null) {
            // 动作意图只转发给 MediaSession（回调进 WebView），不重复 startForeground
            switch (act) {
                case ACTION_PLAY: ms.getController().getTransportControls().play(); break;
                case ACTION_PAUSE: ms.getController().getTransportControls().pause(); break;
                case ACTION_NEXT: ms.getController().getTransportControls().skipToNext(); break;
                case ACTION_PREV: ms.getController().getTransportControls().skipToPrevious(); break;
            }
            return START_STICKY;
        }
        startForeground(NOTI_ID, buildNotification());
        if (wl == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CurrentMusic:playback");
            wl.setReferenceCounted(false);
        }
        acquireLock();
        return START_STICKY;
    }

    /** 唤醒锁续租：Android 的 acquire 超时到期即自动释放，长播（尤其息屏 Doze）会被冻住——
     *  定时续租，避免 4 小时到期后播放莫名暂停。 */
    private void acquireLock() {
        if (wl == null) return;
        if (!wl.isHeld()) wl.acquire(10 * 60 * 1000L);   // 单次 10 分钟，由下面的定时器不断续
        main.removeCallbacks(renewLock);
        main.postDelayed(renewLock, 9 * 60 * 1000L);
    }
    private final Runnable renewLock = new Runnable() {
        @Override public void run() {
            if (wl != null && wl.isHeld()) { wl.release(); }
            acquireLock();
        }
    };

    /** 用户划掉任务卡片：WebView 随之销毁，音频不可能继续——清干净（撤通知、释放锁、停服务），
     *  否则会留下一个「按了没反应」的僵尸媒体通知，锁屏控件也点不动。 */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }



    // 服务未启动时（首播竞态：mediaMeta 先于 keepAlive 的 startService 到达）暂存，
    // onCreate 后恢复，首条通知即带正确曲目
    private static String pTitle = "CurrentMusic", pArtist = "", pAlbum = "", pPic = "";
    private static long pDur = 0;
    private static boolean pPlaying = false;
    private static long pPos = 0;
    static PlaybackService inst;

    /** 桥调用入口（服务可能尚未启动——先静态暂存，onCreate 后首次通知即恢复）。 */
    static void setMediaInfo(String t, String a, String al, long dur, String pic) {
        pTitle = t; pArtist = a; pAlbum = al; pDur = dur; pPic = pic;
        PlaybackService s = inst;
        if (s != null) s.applyMediaInfo(t, a, al, dur, pic);
    }

    static void setPlaybackState(boolean playing, long posMs) {
        pPlaying = playing; pPos = posMs;
        PlaybackService s = inst;
        if (s != null) s.applyPlaybackState(playing, posMs);
    }

    private void applyMediaInfo(String t, String a, String al, long dur, String pic) {
        title = t == null || t.isEmpty() ? "CurrentMusic" : t;
        artist = a == null ? "" : a;
        album = al == null ? "" : al;
        durationMs = Math.max(0, dur);
        if (pic != null && !pic.equals(artUrl)) {
            artUrl = pic;
            art = null;
            if (!pic.isEmpty()) {
                final String u = pic;
                artEx.execute(() -> {
                    Bitmap b = fetchArt(u);
                    if (b != null && u.equals(artUrl)) {
                        art = b;
                        publishMetadata();
                        notifyNotification();
                    }
                });
            }
        }
        publishMetadata();
        notifyNotification();
    }

    private void applyPlaybackState(boolean isPlaying, long posMs) {
        playing = isPlaying;
        positionMs = Math.max(0, posMs);
        publishState();
        notifyNotification();
    }

    private void publishMetadata() {
        if (ms == null) return;
        MediaMetadata.Builder b = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (art != null) b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        ms.setMetadata(b.build());
    }

    private void publishState() {
        if (ms == null) return;
        PlaybackState.Builder b = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        positionMs, playing ? 1f : 0f);
        ms.setPlaybackState(b.build());
    }

    private Notification buildNotification() {
        publishMetadata();
        publishState();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle(title)
                .setContentText(artist.isEmpty() ? "正在播放" : artist)
                .setSubText(album.isEmpty() ? null : album)
                .setSmallIcon(playing ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(Notification.PRIORITY_LOW)
                .setContentIntent(pi(ACTION_PLAY))   // 点通知回 App（播放动作由回调幂等处理）
                .setStyle(new Notification.MediaStyle().setMediaSession(ms.getSessionToken()));
        if (art != null) b.setLargeIcon(art);
        b.addAction(android.R.drawable.ic_media_previous, "上一首", pi(ACTION_PREV));
        b.addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "暂停" : "播放", pi(playing ? ACTION_PAUSE : ACTION_PLAY));
        b.addAction(android.R.drawable.ic_media_next, "下一首", pi(ACTION_NEXT));
        return b.build();
    }

    private PendingIntent pi(String action) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void notifyNotification() {
        try {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTI_ID, buildNotification());
        } catch (Exception ignored) {
            // 通知权限未授予等情况：服务与播放不受影响
        }
    }

    private Bitmap fetchArt(String u) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestProperty("User-Agent", "CurrentMusic/1.0");
            try (InputStream in = c.getInputStream()) {
                return BitmapFactory.decodeStream(in);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(renewLock);
        if (ms != null) {
            ms.setActive(false);
            ms.release();
            ms = null;
        }
        if (wl != null && wl.isHeld()) wl.release();
        inst = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
