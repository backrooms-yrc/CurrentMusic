package com.rcst20.currentmusic;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final String TAG = "CurrentMusic";
    private static final String LOCAL_HOST = "cm.local";
    private static final String START_URL = "https://cm.local/index.html";
    private static final int REQ_FILE = 42;

    private WebView web;
    private int insetT, insetB, insetL, insetR;   // 系统栏真实 insets（env() 在 WebView 常为 0）
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private long lastBack = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Edge-to-edge：内容延伸到状态栏/手势条之下，由前端 env(safe-area-inset-*) 收边
        // （否则底部进度条与系统手势条之间永远有一条系统预留空隙）
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 平板/大屏：启动即沉浸式隐藏系统导航栏（滑动临时呼出），迷你条贴物理底边
        hideSystemNav();

        // 系统栏 insets 实时桥接给页面 CSS 变量（--safe-t/b/l/r）
        getWindow().getDecorView().setOnApplyWindowInsetsListener((v, ins) -> {
            pushInsets(ins);
            return v.onApplyWindowInsets(ins);
        });

        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "NativeApi");
        applySystemBars();
        web.loadUrl(START_URL);
    }

    private boolean isSystemDark() {
        int m = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return m == Configuration.UI_MODE_NIGHT_YES;
    }

    private void applySystemBars() {
        boolean dark = isSystemDark();
        int bar = dark ? 0xFF141218 : 0xFFF7F2FA;
        getWindow().setStatusBarColor(bar);
        getWindow().setNavigationBarColor(bar);
        if (Build.VERSION.SDK_INT >= 23) {
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            if (!dark) flags |= 0x2000; // SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            else flags &= ~0x2000;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBars();
        // 主题变化时通知页面（auto 模式跟随）
        main.post(() -> {
            if (web != null) web.evaluateJavascript(
                    "window.dispatchEvent(new Event('cmthemechange'))", null);
        });
    }

    // ---------- 本地资产服务：https://cm.local → assets/www ----------

    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!"https".equals(u.getScheme()) || !LOCAL_HOST.equals(u.getHost())) {
                return null; // 媒体/封面等外部 http 资源由 WebView 直连
            }
            String path = u.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
            String rel = "www" + path;
            try {
                InputStream in = getAssets().open(rel);
                return new WebResourceResponse(guessMime(path), null, in);
            } catch (IOException e) {
                try {
                    InputStream in = getAssets().open("www/index.html"); // SPA 回退
                    return new WebResourceResponse("text/html", "utf-8", in);
                } catch (IOException e2) {
                    return notFound();
                }
            }
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                java.util.Collections.singletonMap("Cache-Control", "no-store"),
                new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
    }

    private static String guessMime(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : "";
        switch (ext) {
            case "html": return "text/html";
            case "js": return "application/javascript";
            case "css": return "text/css";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "svg": return "image/svg+xml";
            case "json": return "application/json";
            case "woff2": return "font/woff2";
            case "ico": return "image/x-icon";
            default: return "application/octet-stream";
        }
    }

    // ---------- Chrome 客户端：日志 + 头像文件选择 ----------

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, "[web] " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("image/*");
            startActivityForResult(Intent.createChooser(i, "选择图片"), REQ_FILE);
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE) return;
        Uri[] out = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            out = new Uri[]{data.getData()};
        }
        if (fileCallback != null) {
            fileCallback.onReceiveValue(out);
            fileCallback = null;
        }
    }

    // ---------- JS 桥 ----------

    private class Bridge {

        /** 无 CORS 的 HTTP 请求：后台线程执行，结果经 __cmHttpDone 回调。 */
        @JavascriptInterface
        public void http(String id, String method, String url, String headersJson, String body) {
            pool.execute(() -> doHttp(id, method, url, headersJson, body));
        }

        @JavascriptInterface
        public boolean isDarkMode() {
            return isSystemDark();
        }

        @JavascriptInterface
        public void finishApp() {
            main.post(() -> finishAndRemoveTask());
        }

        @JavascriptInterface
        public String appVersion() {
            return "1.8.0";
        }

        /** 后台播放保活：true=启动前台服务（通知+唤醒锁），false=停止。 */
        @JavascriptInterface
        public void keepAlive(final boolean on) {
            main.post(() -> {
                if (on) startPlaybackService();
                else stopService(new Intent(MainActivity.this, PlaybackService.class));
            });
        }

        /** 申请保活相关权限：通知（13+运行时）+ 电池优化白名单。 */
        @JavascriptInterface
        public void requestKeepAlivePerms() {
            main.post(() -> {
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_PERM);
                }
                try {
                    Intent i = new Intent(
                            android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            android.net.Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    Log.w(TAG, "battery opt intent failed: " + e);
                }
            });
        }

        /** 下载到公共音乐目录（DownloadManager，系统通知显示进度与完成后可打开）。 */
        @JavascriptInterface
        public void download(final String url, final String fileName, final String subDir) {
            main.post(() -> startDownload(url, fileName, subDir));
        }
    }

    @SuppressLint("InlinedApi")
    private void startPlaybackService() {
        try {
            startForegroundService(new Intent(this, PlaybackService.class));
        } catch (Exception e) {
            Log.w(TAG, "start playback service failed: " + e);
        }
    }

    private void hideSystemNav() {
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController ic = getWindow().getInsetsController();
            if (ic != null) {
                ic.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                ic.hide(android.view.WindowInsets.Type.navigationBars());
            }
        } else {
            android.view.View d = getWindow().getDecorView();
            d.setSystemUiVisibility(d.getSystemUiVisibility()
                    | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemNav();   // 对话框等场景后重新进入沉浸
    }

    private void pushInsets(android.view.WindowInsets ins) {
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets i = ins.getInsets(
                    android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
            insetT = i.top; insetB = i.bottom; insetL = i.left; insetR = i.right;
        } else {
            insetT = ins.getSystemWindowInsetTop();
            insetB = ins.getSystemWindowInsetBottom();
            insetL = ins.getSystemWindowInsetLeft();
            insetR = ins.getSystemWindowInsetRight();
        }
        final String js = String.format(java.util.Locale.US,
                "var r=document.documentElement.style;" +
                "r.setProperty('--safe-t','%dpx');r.setProperty('--safe-b','%dpx');" +
                "r.setProperty('--safe-l','%dpx');r.setProperty('--safe-r','%dpx');" +
                "window.dispatchEvent(new Event('resize'))",
                insetT, insetB, insetL, insetR);
        main.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    private static final int REQ_PERM = 43;

    @SuppressLint("InlinedApi")
    private void startDownload(String url, String fileName, String subDir) {
        if (Build.VERSION.SDK_INT < 29) {
            if (checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, REQ_PERM);
                Toast.makeText(this, "请授权存储权限后重试下载", Toast.LENGTH_LONG).show();
                return;
            }
        }
        try {
            String safeName = fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
            String safeDir = (subDir == null || subDir.trim().isEmpty())
                    ? "CurrentMusic" : subDir.replaceAll("[\\\\/:*?\"<>|]", "_");
            android.app.DownloadManager.Request req = new android.app.DownloadManager.Request(
                    android.net.Uri.parse(url));
            req.setTitle(safeName);
            req.setDescription("CurrentMusic 下载");
            req.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(
                    android.os.Environment.DIRECTORY_MUSIC, "/" + safeDir + "/" + safeName);
            req.setAllowedOverMetered(true);
            req.setMimeType("audio/*");
            android.app.DownloadManager dm = (android.app.DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Toast.makeText(this, "已开始下载：" + safeName, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.w(TAG, "download failed: " + e);
            Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void doHttp(String id, String method, String url, String headersJson, String body) {
        int status = 0;
        String resp = "{\"error\":\"网络请求失败\"}";
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            c = (HttpURLConnection) u.openConnection();
            c.setRequestMethod(method.toUpperCase());
            c.setConnectTimeout(20000);
            c.setReadTimeout(75000); // 首次自动音质探测/冷歌词可达 20s+
            c.setRequestProperty("Accept", "application/json");
            if (headersJson != null && headersJson.length() > 2) {
                JSONObject h = new JSONObject(headersJson);
                java.util.Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    c.setRequestProperty(k, h.getString(k));
                }
            }
            if (body != null && !body.isEmpty()) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.getBytes(StandardCharsets.UTF_8).length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            status = c.getResponseCode();
            InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
            resp = is == null ? "" : readAll(is);
            if (resp.isEmpty()) resp = "{}";
        } catch (Exception e) {
            Log.w(TAG, "http " + method + " " + url + " failed: " + e);
            status = 0;
            resp = "{\"error\":\"" + e.getClass().getSimpleName() + ": " + sanitize(e.getMessage()) + "\"}";
        } finally {
            if (c != null) c.disconnect();
        }
        final int st = status;
        final String payload = resp;
        main.post(() -> {
            if (web == null) return;
            String js = "window.__cmHttpDone && window.__cmHttpDone("
                    + JSONObject.quote(id) + "," + st + "," + JSONObject.quote(payload) + ")";
            web.evaluateJavascript(js, null);
        });
    }

    private static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String sanitize(String s) {
        if (s == null) return "unknown";
        return s.replace("\"", "'").replace("\n", " ").replace("\\", "/");
    }

    // ---------- 返回键：关播放页 → 回首页 → 双击退出 ----------

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.__cmHandleBack ? window.__cmHandleBack() : false", v -> {
            if (web == null) return;
            if (v != null && Boolean.parseBoolean(v)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) {
                finishAndRemoveTask();
            } else {
                lastBack = now;
                Toast.makeText(this, "再按一次退出 CurrentMusic", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
