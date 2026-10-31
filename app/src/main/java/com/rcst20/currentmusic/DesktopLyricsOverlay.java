package com.rcst20.currentmusic;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 桌面悬浮歌词：一个可拖动、半透明深色胶囊窗口，显示当前歌词与下一句/翻译。
 *
 * 设计参考 CurrentMusicX 的桌面歌词岛：常驻悬浮窗由播放前台服务托管，不依赖
 * Activity 存活；拖动位置按屏幕比例保存在原生 SharedPreferences 中，旋转后重新夹紧。
 * 点击胶囊回到 App，通知栏的「桌面歌词」动作可随时开关。
 *
 * WebView 通过 NativeApi.desktopLyric(current, next) 推送文本——原生只负责
 * 渲染和摆放，歌词同步仍以网页播放器的 currentTime 为唯一时钟。
 */
final class DesktopLyricsOverlay {

    static final String PREFS = "cm_native";
    static final String KEY_ENABLED = "desktop_lyrics_enabled";
    private static final String KEY_X = "desktop_lyrics_x";
    private static final String KEY_Y = "desktop_lyrics_y";
    private static final String TAG = "CurrentMusicLyrics";
    private static final int COLOR_BG_TOP = 0xF216181E;
    private static final int COLOR_BG_BOTTOM = 0xE60B0D11;
    private static final int COLOR_CURRENT = Color.WHITE;
    private static final int COLOR_SECONDARY = 0xB3FFFFFF;
    private static final int COLOR_ACCENT = 0xFF5AA9FF;

    private static DesktopLyricsOverlay inst;
    private static String sCurrent = "桌面歌词已开启";
    private static String sNext = "播放歌曲后显示歌词";

    private final Service service;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WindowManager wm;
    private WindowManager.LayoutParams lp;
    private LinearLayout root;
    private TextView current;
    private TextView secondary;
    private int touchSlop;
    private boolean dragging;
    private float downRawX, downRawY;
    private int downX, downY;
    private int statusBarPx = -1;
    private int navBarPx = -1;

    private DesktopLyricsOverlay(Service service) {
        this.service = service;
        this.wm = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context c) {
        return prefs(c).getBoolean(KEY_ENABLED, false);
    }

    static void setEnabled(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY_ENABLED, on).apply();
    }

    static boolean hasPermission(Context c) {
        return Settings.canDrawOverlays(c);
    }

    /** 是否应该显示：用户已开启且悬浮窗权限仍有效。 */
    static boolean isActive(Context c) {
        return isEnabled(c) && hasPermission(c);
    }

    static boolean isAttached() {
        return inst != null;
    }

    /** 给设置页/通知栏动作读取的原生状态。 */
    static String stateJson(Context c) {
        boolean permission = hasPermission(c);
        boolean enabled = isEnabled(c) && permission;
        return "{\"supported\":true,\"permission\":" + permission
                + ",\"enabled\":" + enabled
                + ",\"attached\":" + (inst != null) + "}";
    }

    static void pushState(Context c) {
        MainActivity.runJs("window.__cmDesktopLyricsState&&window.__cmDesktopLyricsState("
                + stateJson(c) + ")");
    }

    static void requestLyrics() {
        MainActivity.runJs("window.__cmDesktopLyricsRequest&&window.__cmDesktopLyricsRequest()");
    }

    /** 播放服务启动时恢复上一次的悬浮窗；权限被撤销时不要制造一个看不见的开关。 */
    static void restore(Service service) {
        if (!isEnabled(service)) return;
        if (!hasPermission(service)) {
            setEnabled(service, false);
            pushState(service);
            return;
        }
        attach(service);
        requestLyrics();
        pushState(service);
    }

    static void attach(Service service) {
        if (inst != null) return;
        if (!hasPermission(service)) return;
        inst = new DesktopLyricsOverlay(service);
        inst.show();
    }

    static void detach() {
        DesktopLyricsOverlay old = inst;
        inst = null;
        if (old != null) old.remove();
    }

    /** WebView 每次行变化时推送；没有悬浮窗时只更新静态缓存，下次 attach 立即带上。 */
    static void updateLyric(String current, String next) {
        sCurrent = clean(current, "暂无歌词");
        sNext = clean(next, "");
        DesktopLyricsOverlay m = inst;
        if (m != null) {
            m.main.post(() -> {
                if (inst == m) m.applyText(DesktopLyricsOverlay.sCurrent, DesktopLyricsOverlay.sNext, true);
            });
        }
    }

    static void onConfigurationChanged() {
        DesktopLyricsOverlay m = inst;
        if (m != null) m.main.post(m::reposition);
    }

    private static String clean(String s, String fallback) {
        String v = s == null ? "" : s.trim();
        return v.isEmpty() ? fallback : v;
    }

    private void show() {
        root = buildView();
        int sw = screenWidth();
        int width = Math.max(1, Math.min(dp(420), sw - dp(16)));
        lp = new WindowManager.LayoutParams();
        lp.type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp.format = PixelFormat.TRANSLUCENT;
        lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.setTitle("CurrentMusic 桌面歌词");
        lp.width = width;
        lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
        float sx = prefs(service).getFloat(KEY_X, .5f);
        lp.x = Math.round(sx * sw - width / 2f);
        lp.y = Math.round(prefs(service).getFloat(KEY_Y, .12f) * screenHeight());
        clampPositionOnly();
        applyText(sCurrent, sNext, false);
        try {
            wm.addView(root, lp);
            root.post(this::clampAndUpdate);
        } catch (RuntimeException e) {
            android.util.Log.e(TAG, "cannot add desktop lyrics overlay", e);
            DesktopLyricsOverlay.inst = null;
            DesktopLyricsOverlay.setEnabled(service, false);
            root = null;
            pushState(service);
        }
    }

    private LinearLayout buildView() {
        int padH = dp(18), padV = dp(10);
        LinearLayout box = new LinearLayout(service);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(padH, padV, padH, padV);
        box.setClickable(true);
        box.setFocusable(false);
        box.setContentDescription("桌面歌词：拖动调整位置，点击回到 CurrentMusic");
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{COLOR_BG_TOP, COLOR_BG_BOTTOM});
        bg.setCornerRadius(dp(24));
        bg.setStroke(Math.max(1, dp(1)), 0x33FFFFFF);
        box.setBackground(bg);

        current = new TextView(service);
        current.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        current.setTextColor(COLOR_CURRENT);
        current.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        current.setSingleLine(true);
        current.setEllipsize(TextUtils.TruncateAt.MARQUEE);
        current.setMarqueeRepeatLimit(-1);
        current.setHorizontallyScrolling(true);
        current.setSelected(true);
        current.setIncludeFontPadding(false);
        current.setShadowLayer(dp(6), 0, dp(1), 0x66000000);
        box.addView(current, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        secondary = new TextView(service);
        secondary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        secondary.setTextColor(COLOR_SECONDARY);
        secondary.setSingleLine(true);
        secondary.setEllipsize(TextUtils.TruncateAt.END);
        secondary.setIncludeFontPadding(false);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(2);
        box.addView(secondary, slp);

        // 次级行左侧的小蓝点：给歌词一个 X 岛式的视觉锚点，不额外撑高布局。
        GradientDrawable dot = new GradientDrawable();
        dot.setColor(COLOR_ACCENT);
        dot.setCornerRadius(dp(2));
        secondary.setCompoundDrawablePadding(dp(5));
        try {
            dot.setBounds(0, 0, dp(3), dp(3));
            secondary.setCompoundDrawables(dot, null, null, null);
        } catch (RuntimeException ignored) {
            // 装饰失败不影响歌词本身
        }

        touchSlop = ViewConfiguration.get(service).getScaledTouchSlop();
        box.setOnTouchListener(this::onTouch);
        return box;
    }

    private boolean onTouch(View v, MotionEvent e) {
        if (lp == null) return false;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downRawX = e.getRawX();
                downRawY = e.getRawY();
                downX = lp.x;
                downY = lp.y;
                dragging = false;
                return true;
            case MotionEvent.ACTION_MOVE: {
                float dx = e.getRawX() - downRawX;
                float dy = e.getRawY() - downRawY;
                if (!dragging && Math.hypot(dx, dy) > touchSlop) dragging = true;
                if (dragging) {
                    lp.x = downX + Math.round(dx);
                    lp.y = downY + Math.round(dy);
                    clampPositionOnly();
                    try {
                        wm.updateViewLayout(root, lp);
                    } catch (RuntimeException ignored) {
                        // 窗口已被系统移除（权限回收/服务销毁）
                    }
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
                if (dragging) {
                    savePosition();
                } else {
                    openApp();
                }
                dragging = false;
                return true;
            case MotionEvent.ACTION_CANCEL:
                dragging = false;
                return true;
            default:
                return false;
        }
    }

    private void openApp() {
        try {
            Intent i = new Intent(service, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP
                            | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            service.startActivity(i);
        } catch (RuntimeException ignored) {
            // 系统限制后台启动 Activity 时保持歌词可见即可
        }
    }

    private void applyText(String primary, String next, boolean animate) {
        if (current == null || secondary == null) return;
        String p = clean(primary, "暂无歌词");
        String n = next == null ? "" : next.trim();
        if (!animate || current.getWindowToken() == null) {
            if (!p.equals(current.getText().toString())) current.setText(p);
            secondary.setText(n);
            secondary.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);
            return;
        }
        if (p.equals(current.getText().toString())) {
            secondary.setText(n);
            secondary.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);
            return;
        }
        current.animate().cancel();
        current.animate().alpha(0f).translationY(-dp(4)).setDuration(90).withEndAction(() -> {
            if (current == null) return;
            current.setText(p);
            current.setTranslationY(dp(4));
            current.setSelected(true);
            current.animate().alpha(1f).translationY(0f).setDuration(170).start();
        }).start();
        secondary.setText(n);
        secondary.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);
        if (root != null) root.post(this::clampAndUpdate);
    }

    private void remove() {
        LinearLayout r = root;
        root = null;
        if (r != null && wm != null) {
            try {
                wm.removeViewImmediate(r);
            } catch (RuntimeException ignored) {
                // 已经因权限/系统清理被移除
            }
        }
    }

    private void reposition() {
        if (root == null || lp == null) return;
        statusBarPx = -1;
        navBarPx = -1;
        int sw = screenWidth();
        int width = Math.max(1, Math.min(dp(420), sw - dp(16)));
        float sx = prefs(service).getFloat(KEY_X, .5f);
        lp.width = width;
        lp.x = Math.round(sx * sw - width / 2f);
        lp.y = Math.round(prefs(service).getFloat(KEY_Y, .12f) * screenHeight());
        clampPositionOnly();
        try {
            wm.updateViewLayout(root, lp);
        } catch (RuntimeException ignored) {
            remove();
        }
    }

    private void savePosition() {
        if (lp == null) return;
        int sw = Math.max(1, screenWidth());
        int sh = Math.max(1, screenHeight());
        prefs(service).edit()
                .putFloat(KEY_X, (lp.x + lp.width / 2f) / sw)
                .putFloat(KEY_Y, lp.y / (float) sh)
                .apply();
    }

    private void clampPositionOnly() {
        if (root == null || lp == null) return;
        int sw = screenWidth();
        int sh = screenHeight();
        int left = dp(8);
        int top = statusBarHeight() + dp(8);
        int bottom = sh - navigationBottom() - dp(8);
        int maxX = Math.max(left, sw - lp.width - left);
        int maxY = Math.max(top, bottom - Math.max(root.getHeight(), dp(64)));
        lp.x = Math.max(left, Math.min(lp.x, maxX));
        lp.y = Math.max(top, Math.min(lp.y, maxY));
    }

    /** 文本行数变化会改变窗口高度，夹紧后要真正推给 WindowManager。 */
    private void clampAndUpdate() {
        if (root == null || lp == null) return;
        int x = lp.x, y = lp.y;
        clampPositionOnly();
        if (x == lp.x && y == lp.y) return;
        try {
            wm.updateViewLayout(root, lp);
        } catch (RuntimeException ignored) {
            // 窗口已被系统移除
        }
    }

    private int screenWidth() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect b = wm.getCurrentWindowMetrics().getBounds();
            return Math.max(1, b.width());
        }
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        return Math.max(1, dm.widthPixels);
    }

    private int screenHeight() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect b = wm.getCurrentWindowMetrics().getBounds();
            return Math.max(1, b.height());
        }
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        return Math.max(1, dm.heightPixels);
    }

    private int statusBarHeight() {
        if (statusBarPx < 0) {
            int id = service.getResources().getIdentifier("status_bar_height", "dimen", "android");
            statusBarPx = id > 0 ? service.getResources().getDimensionPixelSize(id) : dp(24);
        }
        return statusBarPx;
    }

    private int navigationBottom() {
        if (navBarPx >= 0) return navBarPx;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets insets = wm.getCurrentWindowMetrics().getWindowInsets();
            navBarPx = insets.getInsetsIgnoringVisibility(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()).bottom;
        } else {
            int id = service.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            navBarPx = id > 0 ? service.getResources().getDimensionPixelSize(id) : 0;
        }
        return navBarPx;
    }

    private int dp(int v) {
        return Math.round(v * service.getResources().getDisplayMetrics().density);
    }
}
