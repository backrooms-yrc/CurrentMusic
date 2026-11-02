"""播放抗卡顿的服务端部件（v1.28.23）。

为什么单独一个模块：cm_server.py 已近 3600 行，而这块是「纯策略 + 小状态」，
不 import cm_server 即可单测（CI 的冒烟导入要求本模块 import 无任何副作用）。

四件事：

1. **档位策略**：把「取地址」与「校验地址」拆开——一轮**并行**取各档的地址与
   元信息（上游 *br/type/size*），按旧口径择优后**只对胜出的那一档**做一次
   2KB 音频头校验。旧实现是每档各校验一次（4 次 2KB 探测全串在上游往返后面），
   由于两段是同一个串行线程里跑的，冷启动实测 2.0~2.7s；拆分后约 1 轮上游 + 1 次
   校验，实测 ~1.6s，CDN 探测从 4 次降到 1 次。校验不通过（上游偶尔回 HTML 错误页）
   就按择优顺序顺位重试，与旧实现的「该档不可用则降档」语义等价。

2. **解析单飞**：同一（歌曲, 档位, 上限, 用户 IP）的并发解析合并成一次上游往返。
   预取、正播、卡顿自愈经常同时打同一首，重复探测既慢又容易吃上游风控。

3. **CDN 边缘族切换**（本模块的核心，也是「后端能做、客户端做不到」的那件事）：
   网易云直链形如 ``m801.music.126.net/2026.../<签名>/...``。实测**签名对整个
   ``m7xx``/``m8xx`` 边缘族都有效**——把 host 换成 m702/m703/m804 等，拿到的是
   **逐字节同一个对象**（用整文件 md5 与中段 64KB 双重比对验证过），而两位数字族
   （``m7``/``m8``）与无关域会 400/404，``m705~m711``/``m805``/``m806`` 对部分对象
   404。上游对同一首歌**恒定**返回同一个 host（连续 6 次解析 host 不变），也就是
   说**客户端一旦摊上一条拥堵的 CDN 线，靠自己没有任何办法换线**——只能在同一条
   线上反复重试，这正是「高音质下一直卡」的形态。
   本模块用 2KB 头部取证找出同一对象的其它边缘，供卡顿自愈时**瞬间换线**。

4. **边缘健康度**：客户端上报「这条线卡了 / 这条线好了」，据此给边缘排序避让，
   换线时优先挑没被投诉过的。全部为进程内状态，不写库、不影响其它功能。
"""
from __future__ import annotations

import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# ---------------------------------------------------------------- 档位策略

# 全部音质档（与 cm_server.VALID_LEVELS 同集合；此处只保留策略需要的顺序信息）
TIERS = ("jymaster", "jyeffect", "sky", "hires", "lossless", "exhigh", "standard")

# 旧实现就固定探测这 4 档（不含 hires）——保持一致，避免悄悄改变 auto 的结果。
PROBE_TIERS = ("jymaster", "jyeffect", "sky", "lossless")

# 给了明确上限时，可参与的档位放宽到全部 7 档（否则「上限 = 极高」这类请求
# 会因为 exhigh/standard 不在探测集合里而一档都探不到）。
CAP_TIERS = TIERS

# 各档名义码率（bps，取自 README「音质档位」实测表）。
# 用途：把 maxBr 量化到档位边界（收敛缓存键基数），并据此判定档位是否在上限内。
NOMINAL_BR = {
    "jymaster": 5085163, "jyeffect": 2878732, "sky": 2056087, "hires": 1676530,
    "lossless": 907568, "exhigh": 320001, "standard": 128001,
}

# 码率上限的合理区间（bps）。低于 64k 无意义，高于母带档按母带档处理。
MAX_BR_FLOOR, MAX_BR_CEIL = 64_000, 10_000_000


def quantize_max_br(max_br) -> int:
    """把调用方给的码率上限**向下**量化到档位边界，收敛缓存键基数。

    0 表示「不限」。这样 ``maxBr=1500000``/``1600000`` 都落到无损档（907568），
    7 天的档位缓存不会被任意整数撑爆；向下取整保证「不会超过调用方给的上限」。
    """
    try:
        v = int(max_br or 0)
    except (TypeError, ValueError):
        return 0
    if v <= 0:
        return 0
    v = max(MAX_BR_FLOOR, min(MAX_BR_CEIL, v))
    best = NOMINAL_BR[TIERS[-1]]                      # standard：最低也给它
    for lv in reversed(CAP_TIERS):                    # 由低到高找「不超过 v 的最高档」
        nb = NOMINAL_BR.get(lv, 0)
        if nb <= v:
            best = nb
    return best


def allowed_levels(max_br: int = 0):
    """该上限内允许的档位（降序）。不限时返回全部档位。"""
    if not max_br:
        return tuple(CAP_TIERS)
    return tuple(lv for lv in CAP_TIERS if NOMINAL_BR.get(lv, 0) <= max_br)


def probe_tiers(max_br: int = 0):
    """要向上游取「地址 + 元信息」的档位（降序）。

    - 不限码率：与旧实现完全一致的 4 档；
    - 给了上限：放宽到该上限内的全部档位（否则「上限 = 极高」会因为
      exhigh/standard 不在集合里而一档都取不到）。
    """
    if not max_br:
        return PROBE_TIERS
    allowed = allowed_levels(max_br)
    return allowed or ("standard",)


def ranked(results, max_br: int = 0):
    """按旧口径（score 从大到小）排序、并滤掉超出上限的档位。

    调用方按这个顺序**逐个做音频头校验**：第一个校验通过的就是最终档位。
    这样只需 1 次 2KB 校验（而不是每档都校验一次），同时保留「上游把某档
    降级成错误页时自动顺位」的能力。
    """
    items = [(lv, r) for lv, r in results if r and within(lv, max_br)]
    items.sort(key=lambda kv: score(kv[1]), reverse=True)
    return items


def score(r: dict):
    """与旧 ``best_level`` 完全一致的排序键：先码率，再「是否真无损」，最后体积。"""
    return (r.get("br") or 0, 1 if r.get("type") in ("flac", "wav") else 0, r.get("size") or 0)


def within(level, max_br: int) -> bool:
    """该档位是否在码率上限内——**按档位名义码率判定，不按实测码率**。

    为什么不按实测码率：同一档位不同歌曲的实测码率有漂移（无损档实测 0.79~1.0Mbps
    都见过），按实测值过滤会把「用户想要的无损」误伤掉。按档位判定语义也更直白：
    `maxBr` = 「最多到什么档」。
    """
    if not max_br:
        return True
    return NOMINAL_BR.get(level, 0) <= max_br


def pick(results, max_br: int = 0):
    """按旧口径（score 最大）在 ``max_br`` 内择优，返回 ``(档位, 结果)``。

    ``results`` 形如 ``[(level, result_or_None), ...]``；全部被上限排除时返回
    ``(None, None)``。:func:`ranked` 是它的「全排序」版本，选择逻辑以它为准。
    """
    items = ranked(results, max_br)
    return items[0] if items else (None, None)


# ---------------------------------------------------------------- CDN 边缘族

# 实测存在**两个**可互换的边缘族（同一族内签名通用、返回逐字节同一对象）：
#
#   两位数字族 m7/m8/m9      —— 部分歌曲在大部分真实 IP（国内三大运营商）下由上游
#                               指派到这族（实测 33894312 对所有测试 IP 都是 m7/m8）；
#   三位数字族 m701~m704 / m801~m804 —— 另一些歌曲/地区走这族。
#
# 两族**互不相通**：拿 m7 的签名去打 m701 会 400/403，反之亦然；m705~m711/m805/m806
# 对部分对象 404，m1~m6/m10~m12 超时或 403。所以候选必须**按当前边缘所在族取**，
# 跨族试只是白花时间（还会给对方 CDN 添无谓请求）。
EDGE_FAMILIES = (
    ("m7.music.126.net", "m8.music.126.net", "m9.music.126.net"),
    ("m701.music.126.net", "m702.music.126.net", "m703.music.126.net", "m704.music.126.net",
     "m801.music.126.net", "m802.music.126.net", "m803.music.126.net", "m804.music.126.net"),
)

# 兼容旧引用：全部候选（按族拼接），仅用于展示/文档。
EDGE_HOSTS = tuple(h for fam in EDGE_FAMILIES for h in fam)

_HOST_RE = re.compile(r"^https?://([^/]+)/", re.I)
_EDGE_RE = re.compile(r"^m\d{1,3}\.music\.126\.net$")     # m7/m8/m9 与 m701/m801 都算
EDGE_SUFFIX = ".music.126.net"

# 取证用的头部长度：与 cm_ncm.probe_audio 同口径（2KB 足够覆盖 FLAC STREAMINFO）。
HEAD_BYTES = 2048
HEAD_TIMEOUT = 3.0

# 取证结果的缓存：对象键 -> (hosts, 时间戳)。对象的边缘归属基本不变，缓存 6 小时。
_EDGE_TTL = 6 * 3600
_EDGE_MAX = 400

_UA = {"User-Agent": "CurrentMusic/1.0 (+edge-probe)"}


def host_of(url: str) -> str:
    """取 URL 的 host。"""
    m = _HOST_RE.match(url or "")
    return m.group(1) if m else ""


def normalize_host(value: str) -> str:
    """把调用方给的「直链或裸 host」都归一成小写 host。

    卡顿上报里客户端可能直接写 ``m701.music.126.net``（上报接口本来就是按 host
    维度统计的）；只认 ``host_of`` 会把这种合法上报判成非法。
    """
    v = str(value or "").strip().lower()
    if not v:
        return ""
    if "://" in v:
        return host_of(v)
    return v.split("/")[0].split("?")[0]


def is_edge_host(host: str) -> bool:
    """是否本站认得的网易云边缘域（避免把上报里的任意域名记进健康表）。"""
    return bool(host) and bool(_EDGE_RE.match(host))


def edge_family(host: str):
    """该边缘所属的可互换族（找不到返回空元组）。

    跨族不可换（m7 的签名打 m701 会 400/403），所以候选只在**同族**里取。
    """
    for fam in EDGE_FAMILIES:
        if host in fam:
            return fam
    return ()


def edge_candidates(host: str, limit: int = 0):
    """当前边缘可换的其它边缘（同族、不含自己）。不在已知族里则返回空。"""
    fam = edge_family(host)
    if not fam:
        return []
    out = [h for h in fam if h != host]
    return out[:limit] if limit else out


def with_host(url: str, host: str) -> str:
    """把直链换到另一个边缘，并统一升 https。"""
    if not url or not host:
        return url
    return _HOST_RE.sub(f"https://{host}/", url, count=1)


def head_probe(url: str, n: int = HEAD_BYTES, timeout: float = HEAD_TIMEOUT):
    """取 URL 的前 n 字节（Range 请求）与对象总长。失败返回 ``(None, 0)``。

    总长取自 ``Content-Range`` 的 ``/total``（拿不到就退而取 Content-Length）。
    取证时除了比对字节，还要比对总长——FLAC 的 STREAMINFO 里有整段音频的 MD5，
    前 2KB 基本唯一；再加上总长一致，误判概率可以忽略。
    """
    try:
        req = urllib.request.Request(url, headers=dict(_UA, Range=f"bytes=0-{max(0, n - 1)}"))
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            total = 0
            m = re.search(r"/(\d+)\s*$", resp.headers.get("Content-Range") or "")
            if m:
                total = int(m.group(1))
            elif resp.headers.get("Content-Length"):
                total = int(resp.headers["Content-Length"])
            return resp.read(n), total
    except Exception:  # noqa: BLE001 取证失败一律当作「这条边缘不可用」
        return None, 0


def head_bytes(url: str, n: int = HEAD_BYTES, timeout: float = HEAD_TIMEOUT):
    """只取前 n 字节（见 :func:`head_probe`）。"""
    return head_probe(url, n, timeout)[0]


class EdgeCache:
    """对象边缘取证的缓存（进程内，LRU + TTL）。

    键取 ``(ncm_id, level, size)``：同一个对象不同签名的 host 归属一致，
    所以缓存的是「哪些 host 服务这个对象」，而不是某条具体直链。
    """

    def __init__(self, ttl: int = _EDGE_TTL, cap: int = _EDGE_MAX):
        self._ttl, self._cap = ttl, cap
        self._lock = threading.Lock()
        self._data = {}          # key -> (hosts, ts)

    @staticmethod
    def key(ncm_id, level, size) -> str:
        return f"{int(ncm_id or 0)}:{level or ''}:{int(size or 0)}"

    def get(self, key):
        now = time.time()
        with self._lock:
            e = self._data.get(key)
            if not e:
                return None
            hosts, ts = e
            if now - ts > self._ttl:
                self._data.pop(key, None)
                return None
            return list(hosts)

    def put(self, key, hosts):
        hosts = [h for h in dict.fromkeys(hosts or []) if is_edge_host(h)]
        if not hosts:
            return
        with self._lock:
            self._data[key] = (hosts, time.time())
            if len(self._data) > self._cap:      # 淘汰最旧的一半
                for k in sorted(self._data, key=lambda k: self._data[k][1])[:self._cap // 2]:
                    self._data.pop(k, None)

    def size(self) -> int:
        with self._lock:
            return len(self._data)


class EdgeHealth:
    """边缘健康度：客户端上报的「卡 / 好」，用于换线时避让。

    - ``stall`` 记一次投诉，并按次数给该 host 一段「观察期」（观察期内换线优先避开）；
    - ``ok`` 记一次正常播放，投诉计数衰减（避免一次偶发抖动永久拉黑一条线）。
    """

    STALL_WINDOW = 600.0        # 投诉计数窗口：10 分钟内的投诉算「近期」
    BAD_BASE = 300.0            # 一次投诉的观察期：5 分钟
    BAD_MAX = 1800.0            # 观察期上限：30 分钟
    MAX_HOSTS = 64              # 防上报刷爆内存

    def __init__(self):
        self._lock = threading.Lock()
        # host -> {"stalls","oks","last","last_stall","bad_until"}
        self._stats = {}

    def _slot(self, host):
        s = self._stats.get(host)
        if s is None:
            if len(self._stats) >= self.MAX_HOSTS:
                for k in sorted(self._stats, key=lambda k: self._stats[k]["last"])[:8]:
                    self._stats.pop(k, None)
            s = self._stats[host] = {"stalls": 0, "oks": 0, "last": 0.0,
                                     "last_stall": 0.0, "bad_until": 0.0}
        return s

    def note(self, host: str, event: str, now: float = None) -> bool:
        """记一次上报。返回是否被接受（未知边缘 / 非法事件返回 False）。"""
        if not is_edge_host(host) or event not in ("stall", "ok"):
            return False
        now = time.time() if now is None else now
        with self._lock:
            s = self._slot(host)
            s["last"] = now
            if event == "stall":
                if now - s["last_stall"] > self.STALL_WINDOW:
                    s["stalls"] = 0            # 窗口外的旧投诉不算数
                s["last_stall"] = now
                s["stalls"] += 1
                s["bad_until"] = now + min(self.BAD_MAX, self.BAD_BASE * s["stalls"])
            else:
                s["oks"] += 1
                s["stalls"] = max(0, s["stalls"] - 1)
                if s["stalls"] == 0:
                    s["bad_until"] = 0.0
        return True

    def bad(self, host: str, now: float = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            s = self._stats.get(host)
            return bool(s and s["bad_until"] > now)

    def rank(self, hosts, now: float = None):
        """按健康度排序：没被投诉的在前，投诉多的在后（稳定，打平时保持传入顺序）。"""
        now = time.time() if now is None else now
        with self._lock:
            def key(h):
                s = self._stats.get(h)
                if not s:
                    return (0, 0.0)
                recent = s["stalls"] if now - s["last_stall"] <= self.STALL_WINDOW else 0
                return (recent, s["bad_until"])
            return sorted(list(hosts or []), key=key)

    def snapshot(self, now: float = None):
        now = time.time() if now is None else now
        with self._lock:
            return {
                h: {"stalls": s["stalls"], "oks": s["oks"],
                    "bad": s["bad_until"] > now,
                    "badRemainS": int(max(0.0, s["bad_until"] - now)),
                    "idleS": int(max(0.0, now - s["last"]))}
                for h, s in self._stats.items()
            }


_edges = EdgeCache()
_health = EdgeHealth()


def edges() -> EdgeCache:
    return _edges


def health() -> EdgeHealth:
    return _health


# 取证任务：全局限流 + 单飞，避免一次歌单刷新把 CDN 打爆
_PROBE_CONCURRENCY = 3
_probe_sem = threading.Semaphore(_PROBE_CONCURRENCY)
_discovering = set()
_discover_lock = threading.Lock()


def discover_edges(url: str, size: int = 0, limit: int = 4, timeout: float = HEAD_TIMEOUT):
    """找出服务**同一个对象**的其它边缘 host（同步；显式调用 / 测试用）。

    以 ``url`` 的前 2KB 为基准（Range 请求），逐个候选 host 取同样的 2KB：
    **字节完全一致、且对象总长一致**才算同一个对象。返回
    ``[基准 host, 其它已验证 host...]``，最多 ``1 + limit`` 个；
    基准都取不到时返回 ``[]``（此时不该换线）。
    """
    if not url:
        return []
    base_host = host_of(url)
    ref, ref_total = head_probe(url, HEAD_BYTES, timeout)
    if not ref:
        return []
    want_total = int(size or 0) or ref_total        # 上游给的 size 优先，其次用基准测得的
    cands = edge_candidates(base_host, limit=max(0, int(limit)))
    verified = []
    if cands:
        with ThreadPoolExecutor(max_workers=min(4, len(cands))) as ex:
            futs = {ex.submit(head_probe, with_host(url, h), len(ref), timeout): h for h in cands}
            for fut in futs:
                h = futs[fut]
                try:
                    got, got_total = fut.result(timeout=timeout + 1.0)
                except Exception:  # noqa: BLE001
                    got, got_total = None, 0
                if got and got == ref and (not want_total or got_total == want_total):
                    verified.append(h)
    verified = [h for h in cands if h in verified][:max(0, int(limit))]   # 保持候选顺序
    out = ([base_host] if is_edge_host(base_host) else []) + verified
    return out


def remember_edges(ncm_id, level, size, url, limit: int = 4, force: bool = False):
    """取证并缓存某对象的边缘列表（同步）。已缓存且非 force 时直接返回。"""
    key = EdgeCache.key(ncm_id, level, size)
    if not force:
        cached = _edges.get(key)
        if cached:
            return cached
    if not url:
        return None
    if not _probe_sem.acquire(timeout=1.0):
        return None
    try:
        hosts = discover_edges(url, size, limit=limit)
    finally:
        _probe_sem.release()
    if hosts:
        _edges.put(key, hosts)
    return hosts or None


def spawn_discover(ncm_id, level, size, url, limit: int = 4) -> bool:
    """后台取证（不阻塞响应）。已在取证中 / 已有缓存时直接跳过。"""
    key = EdgeCache.key(ncm_id, level, size)
    if _edges.get(key) or not url:
        return False
    with _discover_lock:
        if key in _discovering:
            return False
        _discovering.add(key)
    threading.Thread(target=_discover_bg, args=(key, ncm_id, level, size, url, limit),
                     name="cm-edge-probe", daemon=True).start()
    return True


def _discover_bg(key, ncm_id, level, size, url, limit):
    try:
        if _edges.get(key):
            return
        if not _probe_sem.acquire(timeout=2.0):
            return
        try:
            hosts = discover_edges(url, size, limit=limit)
        finally:
            _probe_sem.release()
        if hosts:
            _edges.put(key, hosts)
    except Exception:  # noqa: BLE001 取证是「尽力而为」，绝不影响播放
        pass
    finally:
        with _discover_lock:
            _discovering.discard(key)


def pick_edge(hosts, current: str = "", now: float = None, health: "EdgeHealth" = None):
    """换线目标：优先「不是当前线、且没被投诉」的边缘。

    ``EdgeHealth.rank`` 保证被投诉的排后面；这里再显式排除当前线（不换就没意义）。
    没有别的线可选时返回空串——调用方必须保持原样，绝不许把播放地址弄丢。

    ``health`` 可注入（默认用模块单例），便于测试。
    """
    h = health or _health
    cands = [x for x in (hosts or []) if x and x != current]
    if not cands:
        return ""
    ranked = h.rank(cands, now=now)
    now = time.time() if now is None else now
    for x in ranked:
        if not h.bad(x, now):
            return x
    return ranked[0]


# ---------------------------------------------------------------- 解析单飞


class SingleFlight:
    """同一 key 的并发调用合并为一次执行（等待者复用结果 / 异常）。

    ``timeout`` 兜底：等超时的一方**自己重跑**，绝不把「等待超时」当成上游失败。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._inflight = {}      # key -> {"ev": Event, "val": any, "err": Exception|None}

    def do(self, key, fn, timeout: float = 30.0):
        with self._lock:
            slot = self._inflight.get(key)
            leader = slot is None
            if leader:
                slot = {"ev": threading.Event(), "val": None, "err": None}
                self._inflight[key] = slot
        if leader:
            try:
                slot["val"] = fn()
            except BaseException as e:  # noqa: BLE001 异常也要广播给等待者
                slot["err"] = e
            finally:
                with self._lock:
                    self._inflight.pop(key, None)
                slot["ev"].set()
            if slot["err"]:
                raise slot["err"]
            return slot["val"]
        if not slot["ev"].wait(timeout):
            return fn()                     # 等超时：自己来，别把播放卡死在这
        if slot["err"]:
            raise slot["err"]
        return slot["val"]

    def inflight(self) -> int:
        with self._lock:
            return len(self._inflight)
