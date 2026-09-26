package com.rcst20.currentmusic;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 极简 DLNA/UPnP AV 投屏客户端（零依赖，纯 JDK/Android 标准库）。
 *
 * 只做投屏必需的三件事：
 *   1. SSDP 发现 MediaRenderer（M-SEARCH → 收 LOCATION → 拉设备描述 → 找 AVTransport 控制地址）
 *   2. AVTransport SOAP 控制：SetAVTransportURI / Play / Pause / Stop / Seek / 查询状态
 *   3. RenderingControl：SetVolume / SetMute
 *
 * 为什么不用 Cling/CyberLink：本项目无 Gradle、纯 javac 手工编译，引入第三方 jar 会破坏
 * 「一条命令出 APK」的构建方式；所需协议面很窄，手写反而更可控（也便于在 JVM 上直接自测）。
 *
 * 注意：SSDP 组播只能在原生层做（WebView 无 UDP 能力），故本类由 MainActivity 的 Bridge 调用。
 */
public final class Dlna {

    /** SSDP 组播地址与端口（UPnP 规范固定值）。 */
    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final String ST_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";
    private static final String AVT = "urn:schemas-upnp-org:service:AVTransport:1";
    private static final String RCS = "urn:schemas-upnp-org:service:RenderingControl:1";

    private Dlna() {
    }

    /** 一台可用于投屏的渲染器。controlUrl / rcUrl 为绝对地址。 */
    public static final class Device {
        public String usn = "";
        public String name = "";
        public String location = "";
        public String controlUrl = "";
        public String rcUrl = "";
        public String model = "";

        public String key() {
            return usn.isEmpty() ? location : usn;
        }

        @Override
        public String toString() {
            return name + "|" + location + "|" + controlUrl;
        }
    }

    public interface DiscoverCallback {
        void onDone(List<Device> devices, String error);
    }

    public interface SimpleCallback {
        void onDone(boolean ok, String error);
    }

    /** 设备当前播放状态（供 App 侧驱动进度条/歌词，并判断是否掉线）。 */
    public static final class Status {
        public String state = "";      // PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING…
        public long posMs = 0;         // 当前播放位置
        public long durMs = 0;         // 曲目总长
        public String uri = "";
        public String error = null;    // 非空表示本次查询失败（设备可能已离线）

        public boolean playing() {
            return "PLAYING".equals(state) || "TRANSITIONING".equals(state) || "RECORDING".equals(state);
        }
    }

    public interface StatusCallback {
        void onDone(Status st);
    }

    // ---------------------------------------------------------------- 发现

    /**
     * 搜索 MediaRenderer。
     *
     * @param timeoutMs 总等待时长（设备通常 0.2~2s 内回应，建议 2500~3500）
     * @param unicastHost 非空时把 M-SEARCH 单播发到该地址（仅用于无组播回环的环境做自测）
     */
    public static void discover(int timeoutMs, String unicastHost, DiscoverCallback cb) {
        discover(timeoutMs, unicastHost, SSDP_PORT, cb);
    }

    /** 同上，但可指定 SSDP 端口（仅自测用；UPnP 标准端口为 1900）。 */
    public static void discover(int timeoutMs, String unicastHost, int udpPort, DiscoverCallback cb) {
        List<Device> found = new ArrayList<Device>();
        String err = null;
        DatagramSocket sock = null;
        java.nio.channels.DatagramChannel ch = null;
        try {
            boolean unicast = unicastHost != null && !unicastHost.isEmpty();
            if (!unicast) {
                // 组播出口网卡：JDK 的 IP_MULTICAST_IF 要 NetworkInterface，Android 的
                // DatagramSocket.setNetworkInterface 要 InetAddress，两者无交集；
                // DatagramChannel 的 setOption 在两处都接受 NetworkInterface → 用 channel 建 socket。
                InetAddress ifaceAddr = pickMulticastInterface();
                if (ifaceAddr != null) {
                    try {
                        NetworkInterface nif = NetworkInterface.getByInetAddress(ifaceAddr);
                        if (nif != null) {
                            ch = java.nio.channels.DatagramChannel.open();
                            ch.setOption(java.net.StandardSocketOptions.IP_MULTICAST_IF, nif);
                            sock = ch.socket();
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }
            if (sock == null) {
                // 显式绑 0.0.0.0：无参构造在部分环境（实测容器里的 JVM）会绑到 IPv6 any，
                // 此时发往 IPv4 组播地址的包收不到任何回应。
                sock = new DatagramSocket(new InetSocketAddress("0.0.0.0", 0));
            }
            sock.setSoTimeout(400);
            byte[] probe = msearch(ST_RENDERER).getBytes(StandardCharsets.UTF_8);
            InetAddress target = InetAddress.getByName(unicast ? unicastHost : SSDP_ADDR);
            // 组播搜索连发两次（UDP 可能丢包；这也是多数实现的通行做法）
            for (int i = 0; i < 2; i++) {
                sock.send(new DatagramPacket(probe, probe.length, target, udpPort));
                Thread.sleep(120);
            }
            long deadline = System.currentTimeMillis() + Math.max(600, timeoutMs);
            Map<String, Device> seen = new LinkedHashMap<String, Device>();
            byte[] buf = new byte[8192];
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(pkt);
                } catch (SocketTimeoutException te) {
                    continue;
                }
                String text = new String(pkt.getData(), pkt.getOffset(), pkt.getLength(),
                        StandardCharsets.UTF_8);
                if (!text.startsWith("HTTP/1.")) continue;
                Map<String, String> h = parseHeaders(text);
                String loc = h.get("location");
                if (loc == null || loc.isEmpty()) continue;
                Device d = new Device();
                d.location = loc;
                d.usn = h.get("usn") == null ? loc : h.get("usn");
                d.model = h.get("server") == null ? "" : h.get("server");
                if (seen.containsKey(d.key())) continue;
                seen.put(d.key(), d);
            }
            // 逐个补全设备描述（名称 + AVTransport 控制地址）；描述拉不到的丢弃
            for (Device d : seen.values()) {
                try {
                    fillFromDescription(d);
                    if (!d.controlUrl.isEmpty()) found.add(d);
                } catch (Exception ignored) {
                }
            }
        } catch (Exception e) {
            err = e.getClass().getSimpleName() + ": " + e.getMessage();
        } finally {
            if (sock != null) sock.close();
            if (ch != null) { try { ch.close(); } catch (Exception ignored) { } }
        }
        cb.onDone(found, err);
    }

    private static String msearch(String st) {
        return "M-SEARCH * HTTP/1.1\r\n"
                + "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n"
                + "MAN: \"ssdp:discover\"\r\n"
                + "MX: 2\r\n"
                + "ST: " + st + "\r\n"
                + "\r\n";
    }

    /** 有默认路由的 IPv4 网卡优先（避开蜂窝/VPN 造成搜不到设备）。 */
    private static InetAddress pickMulticastInterface() {
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (nif.isLoopback() || !nif.isUp() || !nif.supportsMulticast()) continue;
                for (InetAddress a : Collections.list(nif.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 设备描述 XML → friendlyName + AVTransport/RenderingControl 的绝对控制地址。 */
    static void fillFromDescription(Device d) throws IOException {
        String xml = httpText(d.location);
        String base = baseUrl(d.location);
        d.name = firstTag(xml, "friendlyName");
        if (d.name.isEmpty()) d.name = "DLNA 设备";
        if (d.model.isEmpty()) d.model = firstTag(xml, "modelName");

        // serviceList 里每个 <service> 块按 serviceType 取 controlURL
        Matcher m = Pattern.compile("<service>(.*?)</service>", Pattern.DOTALL | Pattern.CASE_INSENSITIVE)
                .matcher(xml);
        while (m.find()) {
            String block = m.group(1);
            String type = firstTag(block, "serviceType");
            String ctrl = firstTag(block, "controlURL");
            if (ctrl.isEmpty()) continue;
            String abs = absolute(base, ctrl);
            if (d.controlUrl.isEmpty() && type.contains("AVTransport")) d.controlUrl = abs;
            if (d.rcUrl.isEmpty() && type.contains("RenderingControl")) d.rcUrl = abs;
        }
        // 少数设备描述里直接给绝对地址，兜底处理
        if (d.controlUrl.isEmpty()) {
            Matcher am = Pattern.compile("<controlURL>\\s*(https?://[^<]+)</controlURL>",
                    Pattern.CASE_INSENSITIVE).matcher(xml);
            if (am.find()) d.controlUrl = am.group(1).trim();
        }
    }

    // ---------------------------------------------------------------- 控制

    /** 设置播放地址并开始播放。meta 由 didl() 生成；部分设备不接受空 meta。 */
    public static void playUrl(Device d, String url, String meta, SimpleCallback cb) {
        try {
            soap(d.controlUrl, AVT, "SetAVTransportURI",
                    "<InstanceID>0</InstanceID>"
                            + "<CurrentURI>" + esc(url) + "</CurrentURI>"
                            + "<CurrentURIMetaData>" + esc(meta == null ? "" : meta) + "</CurrentURIMetaData>");
            soap(d.controlUrl, AVT, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
            cb.onDone(true, null);
        } catch (Exception e) {
            cb.onDone(false, msg(e));
        }
    }

    /** action: Play / Pause / Stop / Seek / GetTransportInfo / GetPositionInfo */
    public static void command(Device d, String action, String extraArgs, SimpleCallback cb) {
        try {
            String args = "<InstanceID>0</InstanceID>" + (extraArgs == null ? "" : extraArgs);
            String body = soap(d.controlUrl, AVT, action, args);
            cb.onDone(true, body);
        } catch (Exception e) {
            cb.onDone(false, msg(e));
        }
    }

    /**
     * 查询设备播放状态（GetTransportInfo + GetPositionInfo）。
     * 任何一次失败都视为「设备可能已离线」，在 Status.error 里给出原因。
     */
    public static void poll(Device d, StatusCallback cb) {
        Status st = new Status();
        try {
            String ti = soap(d.controlUrl, AVT, "GetTransportInfo", "<InstanceID>0</InstanceID>");
            st.state = firstTag(ti, "CurrentTransportState");
            String pi = soap(d.controlUrl, AVT, "GetPositionInfo", "<InstanceID>0</InstanceID>");
            st.posMs = parseUpnpTime(firstTag(pi, "RelTime"));
            st.durMs = parseUpnpTime(firstTag(pi, "TrackDuration"));
            st.uri = firstTag(pi, "TrackURI");
        } catch (Exception e) {
            st.error = msg(e);
        }
        cb.onDone(st);
    }

    /** UPnP 时间串（H:MM:SS[.f] 或 NOT_IMPLEMENTED）→ 毫秒；无法解析返回 0。 */
    static long parseUpnpTime(String s) {
        if (s == null) return 0;
        String t = s.trim();
        if (t.isEmpty() || t.startsWith("NOT_IMPLEMENTED")) return 0;
        int colon = t.indexOf(':');
        try {
            if (colon < 0) {                       // 纯秒
                return (long) (Double.parseDouble(t) * 1000);
            }
            String[] parts = t.split(":");
            long h = 0, m = 0;
            double sec = 0;
            if (parts.length == 3) {
                h = Long.parseLong(parts[0].trim());
                m = Long.parseLong(parts[1].trim());
                sec = Double.parseDouble(parts[2].trim());
            } else if (parts.length == 2) {
                m = Long.parseLong(parts[0].trim());
                sec = Double.parseDouble(parts[1].trim());
            } else {
                return 0;
            }
            return (long) ((h * 3600 + m * 60 + sec) * 1000);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    public static void setVolume(Device d, int vol0to100, SimpleCallback cb) {
        if (d.rcUrl == null || d.rcUrl.isEmpty()) {
            cb.onDone(false, "该设备未提供音量控制");
            return;
        }
        try {
            String body = soap(d.rcUrl, RCS, "SetVolume",
                    "<InstanceID>0</InstanceID><Channel>Master</Channel>"
                            + "<DesiredVolume>" + Math.max(0, Math.min(100, vol0to100)) + "</DesiredVolume>");
            cb.onDone(true, body);
        } catch (Exception e) {
            cb.onDone(false, msg(e));
        }
    }

    /** DIDL-Lite 元数据：多数渲染器要靠它识别媒体类型；audio/flac 等按扩展名推不出时给 octet-stream。 */
    public static String didl(String url, String title, String artist, String album, long durationMs) {
        String dur = durationMs > 0 ? formatDuration(durationMs) : "";
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" "
                + "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
                + "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">"
                + "<item id=\"1\" parentID=\"0\" restricted=\"1\">"
                + "<dc:title>" + esc(title) + "</dc:title>"
                + "<dc:creator>" + esc(artist) + "</dc:creator>"
                + "<upnp:artist>" + esc(artist) + "</upnp:artist>"
                + "<upnp:album>" + esc(album) + "</upnp:album>"
                + "<upnp:class>object.item.audioItem.musicTrack</upnp:class>"
                + "<res" + (dur.isEmpty() ? "" : " duration=\"" + dur + "\"")
                + " protocolInfo=\"" + protocolInfo(url) + "\">" + esc(url) + "</res>"
                + "</item></DIDL-Lite>";
    }

    private static String protocolInfo(String url) {
        String u = url.toLowerCase();
        String mime = u.contains(".flac") ? "audio/flac"
                : u.contains(".mp3") ? "audio/mpeg"
                : u.contains(".m4a") || u.contains(".aac") ? "audio/mp4"
                : u.contains(".wav") ? "audio/wav"
                : "audio/mpeg";
        return "http-get:*:" + mime + ":*";
    }

    /** 毫秒 → UPnP 的 H:MM:SS.mmm。 */
    static String formatDuration(long ms) {
        long s = ms / 1000;
        return String.format("%d:%02d:%02d.%03d", s / 3600, (s % 3600) / 60, s % 60, ms % 1000);
    }

    // ---------------------------------------------------------------- 协议底层

    /**
     * 组装并 POST 一个 UPnP action（SOAP 1.1）。
     * 设备返回非 200 时把响应体一并抛出——很多设备在 faultstring 里给出可读原因。
     */
    static String soap(String controlUrl, String serviceType, String action, String args)
            throws IOException {
        String envelope = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>"
                + "<u:" + action + " xmlns:u=\"" + serviceType + "\">" + args + "</u:" + action + ">"
                + "</s:Body></s:Envelope>";
        byte[] body = envelope.getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = (HttpURLConnection) new URL(controlUrl).openConnection();
        try {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(6000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
            c.setRequestProperty("SOAPAction", "\"" + serviceType + "#" + action + "\"");
            c.setRequestProperty("User-Agent", "CurrentMusic/1.0 UPnP/1.0");
            c.setFixedLengthStreamingMode(body.length);
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String resp = in == null ? "" : readAll(in);
            if (code >= 400) throw new IOException("设备返回 " + code + "：" + faultOf(resp));
            return resp;
        } finally {
            c.disconnect();
        }
    }

    /** 从 SOAP fault 中提取可读原因，取不到就回退原文前 120 字。 */
    static String faultOf(String xml) {
        String s = firstTag(xml, "faultstring");
        if (!s.isEmpty()) return s;
        String e = firstTag(xml, "errorDescription");
        if (!e.isEmpty()) return e;
        String t = xml == null ? "" : xml.replaceAll("\\s+", " ").trim();
        return t.length() > 120 ? t.substring(0, 120) : t;
    }

    static String httpText(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(6000);
            c.setReadTimeout(10000);
            c.setRequestProperty("User-Agent", "CurrentMusic/1.0 UPnP/1.0");
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) throw new IOException("HTTP " + code);
            if (code >= 400) throw new IOException("HTTP " + code);
            return readAll(in);
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 大小写不敏感的响应头解析（LOCATION 等键统一转小写）。 */
    static Map<String, String> parseHeaders(String text) {
        Map<String, String> map = new LinkedHashMap<String, String>();
        String[] lines = text.split("\r\n");
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            map.put(lines[i].substring(0, c).trim().toLowerCase(),
                    lines[i].substring(c + 1).trim());
        }
        return map;
    }

    static String firstTag(String xml, String tag) {
        if (xml == null) return "";
        Matcher m = Pattern.compile("<(?:\\w+:)?" + tag + "[^>]*>(.*?)</(?:\\w+:)?" + tag + ">",
                Pattern.DOTALL | Pattern.CASE_INSENSITIVE).matcher(xml);
        return m.find() ? m.group(1).trim() : "";
    }

    /** 相对控制地址 → 绝对地址（基于设备描述的 URL）。 */
    static String baseUrl(String url) {
        try {
            URL u = new URL(url);
            int port = u.getPort();
            return u.getProtocol() + "://" + u.getHost() + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return "";
        }
    }

    static String absolute(String base, String path) {
        if (path.startsWith("http://") || path.startsWith("https://")) return path;
        if (base.isEmpty()) return path;
        return path.startsWith("/") ? base + path : base + "/" + path;
    }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }

    private static String msg(Exception e) {
        String m = e.getMessage();
        return (m == null || m.isEmpty()) ? e.getClass().getSimpleName() : m;
    }
}
