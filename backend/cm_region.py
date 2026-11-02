"""IP 属地（v1.28.38）。

需求：发现页用户列表 / 用户主页展示「IP 属地」（如 安徽）。设计取舍：

  · **只存省份，不存原始 IP**。用户表只落一个 `ip_region` 文本；原始 IP 仅以
    /24（IPv4）或 /48（IPv6）网段为键缓存在 `ip_regions` 表里，用于避免重复查询。
  · **不在请求路径上查外部接口**。`note()` 只做一次内存节流判断，然后丢给后台线程：
    命中网段缓存则直接更新用户属地块（毫秒级），未命中才请求一次外部接口（3s 超时），
    失败静默——展示层空字符串就是不显示，绝不影响登录/浏览。
  · 网段缓存 180 天；同一用户最多每 6 小时更新一次属地（避免频繁写库）。
  · 外部接口用 ip-api.com（免费、无需 key、支持 lang=zh-CN 返回中文省份）。
    IPv4 私网/回环/保留地址、IPv6 本机地址一律跳过。
"""
from __future__ import annotations

import ipaddress
import json
import queue
import threading
import time
import urllib.request

import cm_db

LOOKUP_URL = "http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,country,regionName,isp,org,as,hosting,proxy"
CACHE_TTL = 180 * 86400          # 网段→属地缓存有效期
USER_REFRESH = 6 * 3600          # 同一用户属地更新间隔
FAIL_RETRY = 10 * 60             # 查询失败后的重试间隔（不要按 6 小时耗掉）
LOOKUP_INTERVAL = 1.6            # 单线程串行查询的间隔：≤37 次/分钟（限额 45）
LOOKUP_TIMEOUT = 3.0

# 34 个省级行政区（短名）。ip-api 的 regionName 时而是「河北」、时而是「河北省」，
# 统一按前缀归一到短名——列表/主页只展示这一个口径。
_CN_PROVINCES = (
    "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江",
    "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
    "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾",
    "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
)

# ip-api 的中文返回偶有繁体（如「澳大利亞」），统一成常用简体写法
_COUNTRY_FIX = {
    "澳大利亞": "澳大利亚", "俄羅斯": "俄罗斯", "德國": "德国", "法國": "法国",
    "英國": "英国", "韓國": "韩国", "馬來西亞": "马来西亚", "意大利": "意大利",
    "西班牙": "西班牙", "荷蘭": "荷兰", "瑞士": "瑞士", "瑞典": "瑞典",
    "新加坡": "新加坡", "日本": "日本", "加拿大": "加拿大",
    # 中国台湾：统一为主流写法（避免出现「中華民國」这类写法）
    "中華民國": "中国台湾", "台灣": "中国台湾", "臺灣": "中国台湾", "台湾": "中国台湾",
    "中國香港": "香港", "中國澳門": "澳门",
}

# 机房/代理出口识别：这类 IP 的归属地是机房所在地，不代表用户的真实属地。
# 典型例子：Akile/Hytron（香港 VPS）、IDC Cube（ip-api 会判成台湾，ipinfo 判香港）。
_HOSTING_HINTS = ("idc", "akile", "hytron", "hosting", "vps", "data center",
                  "datacenter", "colo", "cloud", "server", "机房", "数据中心")


def looks_hosting(d: dict) -> bool:
    """该 IP 是否机房/代理出口（ip-api 的 hosting/proxy 或 ISP/ORG/AS 关键词）。"""
    if not isinstance(d, dict):
        return False
    if d.get("hosting") or d.get("proxy"):
        return True
    blob = " ".join(str(d.get(k) or "") for k in ("isp", "org", "as")).lower()
    return any(h in blob for h in _HOSTING_HINTS)

_last_note: dict = {}           # uid -> 下次允许尝试的时间戳
_note_lock = threading.Lock()
_queued: set = set()            # 已排队/查询中的网段（同一网段只查一次）
_queued_lock = threading.Lock()
_jobs: "queue.Queue" = queue.Queue()
_worker_lock = threading.Lock()
_worker_started = False


def init_region_tables(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS ip_regions (
      prefix TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    """)


def prefix_of(ip: str) -> str:
    """取查询/缓存用的网段键；私网、回环、保留地址返回空串（不查、不展示）。"""
    try:
        addr = ipaddress.ip_address(str(ip or "").strip())
    except ValueError:
        return ""
    if (addr.is_private or addr.is_loopback or addr.is_reserved
            or addr.is_multicast or addr.is_link_local or addr.is_unspecified):
        return ""
    net = 24 if addr.version == 4 else 48
    return str(ipaddress.ip_network(f"{addr}/{net}", strict=False))


def normalize(country: str, region: str) -> str:
    """属地展示文案：中国取**省级短名**（北京/内蒙古/香港…），其它国家取国家名。"""
    country = (country or "").strip()
    region = (region or "").strip()
    if country.startswith("中国") or country in ("中华人民共和国",):
        if region.startswith("中国"):
            region = region[2:]
        for p in _CN_PROVINCES:            # 前缀匹配：河北省→河北、内蒙古自治区→内蒙古
            if region.startswith(p):
                return p
        if country in ("中国香港", "中国澳门", "中国台湾"):   # 库只给了国家名
            return country[2:]
        return region if region and region.upper() != "N/A" else "中国"
    country = _COUNTRY_FIX.get(country, country)
    return country or region


def _cached(prefix: str) -> str:
    if not prefix:
        return ""
    conn = cm_db.connect()
    try:
        r = conn.execute("SELECT region, ts FROM ip_regions WHERE prefix=?", (prefix,)).fetchone()
        if not r:
            return ""
        if time.time() - int(r["ts"]) > CACHE_TTL:
            return ""
        return r["region"] or ""
    finally:
        conn.close()


def _remember(prefix: str, region: str):
    if not prefix or not region:
        return
    conn = cm_db.connect()
    try:
        conn.execute(
            "INSERT INTO ip_regions(prefix,region,ts) VALUES(?,?,?)"
            " ON CONFLICT(prefix) DO UPDATE SET region=excluded.region, ts=excluded.ts",
            (prefix, region, int(time.time())))
        conn.commit()
    finally:
        conn.close()


def _lookup_raw(ip: str):
    """返回 (属地, 是否机房/代理出口)。查询失败返回 ("", False)，与「代理出口」区分。"""
    try:
        req = urllib.request.Request(LOOKUP_URL.format(ip=ip),
                                     headers={"User-Agent": "CurrentMusic/1.0 (+ip-region)"})
        with urllib.request.urlopen(req, timeout=LOOKUP_TIMEOUT) as r:
            d = json.load(r)
        if not isinstance(d, dict) or d.get("status") != "success":
            return "", False
        if looks_hosting(d):
            # 机房/代理出口：属地是「代理在哪」，不是用户在哪 → 不标注
            return "", True
        return normalize(d.get("country") or "", d.get("regionName") or ""), False
    except Exception:  # noqa: BLE001 外部接口异常一律静默（属地只是展示信息）
        return "", False


def _lookup(ip: str) -> str:
    return _lookup_raw(ip)[0]


def region_of_ip(ip: str) -> str:
    """同步取属地（缓存优先）；未命中返回空串，绝不阻塞等外部接口。"""
    return _cached(prefix_of(ip))


def _ensure_worker():
    global _worker_started
    if _worker_started:
        return
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True
        threading.Thread(target=_worker, name="cm-ip-region", daemon=True).start()


def _worker():
    """串行处理查询队列：限速在免费额度内，失败允许稍后重试。"""
    while True:
        uid, ip, prefix = _jobs.get()
        try:
            region = _cached(prefix)
            hosting = False
            if not region:
                region, hosting = _lookup_raw(ip)
            if region:
                _remember(prefix, region)
                cm_db.set_user_region(uid, region)
            elif hosting:
                # 当前走的是机房/代理出口：清掉旧标注，避免继续展示代理落点
                cm_db.set_user_region(uid, "")
            else:
                # 查询失败：10 分钟后再试（而不是按 6 小时节流白等）
                with _note_lock:
                    _last_note[uid] = time.time() - USER_REFRESH + FAIL_RETRY
        except Exception:  # noqa: BLE001
            pass
        finally:
            with _queued_lock:
                _queued.discard(prefix)
            _jobs.task_done()
            time.sleep(LOOKUP_INTERVAL)


def note(uid: int, ip: str):
    """登录用户每次请求都会经过这里：节流后异步刷新该用户的属地。

    绝不做任何可能抛错的事（调用方是鉴权路径）——异常一律吞掉。
    """
    try:
        prefix = prefix_of(ip)
        if not prefix or not uid:
            return
        now = time.time()
        with _note_lock:
            if now < _last_note.get(uid, 0):
                return
        region = _cached(prefix)
        if region:                                      # 命中缓存：直接更新，成本极低
            with _note_lock:
                _last_note[uid] = now + USER_REFRESH
            cm_db.set_user_region(int(uid), region)
            return
        with _queued_lock:
            if prefix in _queued:                       # 该网段已在查：不重复排队
                return                                  # 也不锁死 uid，下次请求再补
            _queued.add(prefix)
        with _note_lock:
            _last_note[uid] = now + USER_REFRESH
        _ensure_worker()
        _jobs.put((int(uid), ip, prefix))
    except Exception:  # noqa: BLE001
        pass
