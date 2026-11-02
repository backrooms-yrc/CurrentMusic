"""DLNA 投屏用的音频中转。

为什么需要它：投屏是「手机把播放地址交给电视/音箱，由设备自己去拉流」。
而 CurrentMusic 的音源地址是网易云 CDN 的 **https + 带签名参数、约 20 分钟过期** 的链接，
多数 DLNA 渲染器既不支持 https、也无法处理过期签名；直接把原地址丢给设备通常放不出来。

因此这里提供 `/cast/<ncm_id>`：服务端代取音源、以普通 http 对外，并做本地缓存。

**下载与读取分离**（重要）：
渲染器经常对同一地址连发多次请求（初始探测、缓冲不足重连、拖动进度）。
早期实现是「一个请求 = 一次下载、共写同一个 .part 文件」，
并发时互相截断，客户端收到残缺流后直接断开（实测三并发时其中一个只收到 64KB，
这正是「使用中莫名其妙断连」的根因）。
现在改为**每首歌单飞（single-flight）后台下载 + 多个请求各自读取同一文件**：
  - 只有第一个请求触发下载，其余请求直接读已落盘的部分
  - 下载进度以「已确认写入的字节数」发布，读取方按需等待到目标偏移
  - 下载完成后原子改名，之后一律走本地文件（含完整 Range 支持）
"""
import hashlib
import hmac
import os
import random
import re
import secrets
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CM_DATA_DIR", os.path.join(ROOT, "data"))
CACHE_DIR = os.environ.get("CM_CAST_CACHE", os.path.join(DATA_DIR, "cast"))

# 缓存上限：超清母带可达上百 MB；超限时按最后访问时间淘汰
CACHE_LIMIT = int(os.environ.get("CM_CAST_CACHE_BYTES", str(2 * 1024 * 1024 * 1024)))
# 即便没到上限，超过 7 天的投屏缓存也清掉：这些整曲文件长期不用只会占磁盘/页缓存
CACHE_MAX_AGE = int(os.environ.get("CM_CAST_CACHE_MAX_AGE", str(7 * 86400)))

_UA = {"User-Agent": "CurrentMusic/1.0 (+dlna-cast)"}
EXTS = ("flac", "mp3", "m4a", "aac", "wav", "ogg", "ape")

_lock = threading.Lock()
_jobs = {}          # ncm_id -> Job（下载中或刚完成）


# ---------------------------------------------------------------- 投屏签名
# 为什么需要：v1.28.33 起「音源仅限注册用户」。投屏是手机把地址交给电视、由**设备**
# 自己去拉流，设备发不了 Bearer 头；所以改成「登录用户向服务器换取**带签名的短链**，
# 设备凭签名拉流」——没有登录态就签不出来，等价于把音源访问权收在注册用户手里。
#
# 密钥持久化在 data/cast.secret（首次自动生成，0600）：重启后已发出的签名仍有效，
# 否则每次重启都会把正在投屏的设备踢下线。
SECRET_FILE = os.environ.get("CM_CAST_SECRET_FILE", os.path.join(ROOT, "data", "cast.secret"))
SIG_TTL = 6 * 3600          # 签名有效期：覆盖一场长投屏会话（设备会反复重连/拖进度）
_secret_cache = None
_secret_lock = threading.Lock()


def _secret() -> bytes:
    global _secret_cache
    if _secret_cache:
        return _secret_cache
    with _secret_lock:
        if _secret_cache:
            return _secret_cache
        try:
            with open(SECRET_FILE, "rb") as f:
                val = f.read().strip()
        except OSError:
            val = b""
        if len(val) < 32:
            val = secrets.token_bytes(32).hex().encode()
            os.makedirs(os.path.dirname(SECRET_FILE), exist_ok=True)
            fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(val)
        _secret_cache = val
        return val


def _sig_msg(ncm_id, level, exp) -> bytes:
    return f"{int(ncm_id)}:{level or 'auto'}:{int(exp)}".encode()


def sign_cast(ncm_id, level, ttl: int = SIG_TTL):
    """给 (歌曲, 档位) 签一个带过期时间的投屏短链参数。返回 (exp, sig)。"""
    exp = int(time.time()) + int(ttl)
    sig = hmac.new(_secret(), _sig_msg(ncm_id, level, exp), hashlib.sha256).hexdigest()
    return exp, sig


def verify_cast(ncm_id, level, exp, sig) -> bool:
    """校验投屏签名：过期一律拒绝；比较用 compare_digest 防时序侧信道。"""
    try:
        exp = int(exp)
    except (TypeError, ValueError):
        return False
    if exp < int(time.time()):
        return False
    want = hmac.new(_secret(), _sig_msg(ncm_id, level, exp), hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, str(sig or ""))


def _safe_ext(level, url):
    """按实际链接后缀定扩展名（决定协议里的 MIME 类型）。"""
    m = re.search(r"\.(mp3|flac|m4a|aac|wav|ape|ogg)(?:\?|$)", url or "", re.I)
    if m:
        return m.group(1).lower()
    return "flac" if "lossless" in (level or "") or "master" in (level or "") else "mp3"


def cache_path(ncm_id, ext):
    return os.path.join(CACHE_DIR, f"{int(ncm_id)}.{ext}")


def find_cached(ncm_id):
    """已完整缓存的该歌曲文件路径（.part 不算）。"""
    for ext in EXTS:
        fp = cache_path(ncm_id, ext)
        if os.path.isfile(fp) and os.path.getsize(fp) > 0:
            return fp
    return None


def cleanup_stale_parts():
    """清理上次进程遗留的 .part，并顺手淘汰过期/超限的整曲缓存。"""
    try:
        for name in os.listdir(CACHE_DIR):
            if name.endswith(".part"):
                try:
                    os.remove(os.path.join(CACHE_DIR, name))
                except OSError:
                    pass
    except OSError:
        pass
    _evict_if_needed()


def _evict_if_needed():
    """先删过期文件；超出额度时再按 mtime 从旧到新删到额度内（保留最近用过的）。"""
    try:
        now = time.time()
        files, total = [], 0
        for name in os.listdir(CACHE_DIR):
            fp = os.path.join(CACHE_DIR, name)
            if not os.path.isfile(fp) or name.endswith(".part"):
                continue
            st = os.stat(fp)
            if CACHE_MAX_AGE > 0 and now - st.st_mtime > CACHE_MAX_AGE:
                try:
                    os.remove(fp)
                    continue
                except OSError:
                    pass
            files.append((st.st_mtime, st.st_size, fp))
            total += st.st_size
        if total <= CACHE_LIMIT:
            return
        files.sort()
        for _, size, fp in files:
            if total <= CACHE_LIMIT:
                break
            try:
                os.remove(fp)
                total -= size
            except OSError:
                pass
    except OSError:
        pass


class Job:
    """一首歌的下载任务：后台单飞执行，多个读者共享同一份落盘数据。"""

    def __init__(self, ncm_id, url, ext):
        self.ncm_id = ncm_id
        self.url = url
        self.ext = ext
        self.final = cache_path(ncm_id, ext)
        # 临时文件带唯一后缀：同一首歌若因失败被重建任务，两个任务也绝不会写同一个文件
        # （共写会导致客户端读到互相截断的残缺流——「莫名其妙断连」的老根因）
        self.tmp = f"{self.final}.{os.getpid()}-{random.randint(1000, 999999)}.part"
        self.total = 0            # 上游声明的总长度（0=未知）
        self.available = 0        # 已确认写入的字节数
        self.done = False
        self.error = None
        self.cond = threading.Condition()
        self.thread = None
        self.started = time.time()

    # ---------- 读者接口 ----------

    def wait_bytes(self, want, timeout=30.0):
        """等到「至少 want 字节可读」或下载结束/出错。返回当前可用字节数。"""
        deadline = time.time() + timeout
        with self.cond:
            while self.available < want and not self.done and self.error is None:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cond.wait(min(left, 0.5))
            return self.available

    def snapshot(self):
        with self.cond:
            return self.available, self.total, self.done, self.error

    def path(self):
        """当前可读的文件路径（下载中为 .part，完成后为正式文件）。"""
        with self.cond:
            if self.done and self.error is None and os.path.isfile(self.final):
                return self.final
            return self.tmp

    # ---------- 下载 ----------

    def _run(self):
        tmp = self.tmp
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            req = urllib.request.Request(self.url, headers=_UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                total = int(r.headers.get("Content-Length") or 0)
                with self.cond:
                    self.total = total
                    self.cond.notify_all()
                f = open(tmp, "wb")
                try:
                    while True:
                        chunk = r.read(64 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        f.flush()          # 让读者立刻看到新数据
                        with self.cond:
                            self.available += len(chunk)
                            self.cond.notify_all()
                finally:
                    f.close()
            os.replace(tmp, self.final)
            _evict_if_needed()
            with self.cond:
                self.done = True
                self.cond.notify_all()
        except Exception as e:  # noqa: BLE001
            print(f"[castdl] 下载失败 ncm_id={self.ncm_id} 已下={self.available}B "
                  f"总长={self.total} 原因={type(e).__name__}: {e}", flush=True)
            with self.cond:
                self.error = f"{type(e).__name__}: {e}"
                self.done = True
                self.cond.notify_all()
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)      # 失败的半成品不能留（会被误当缓存）
            except OSError:
                pass


def ensure_job(ncm_id, url, ext):
    """取得（必要时启动）该歌曲的下载任务。单飞：同一首歌只会有一个下载线程。"""
    if find_cached(ncm_id):
        return None                      # 已完整缓存，不需要任务
    key = int(ncm_id)
    with _lock:
        job = _jobs.get(key)
        if job and not job.done:
            return job
        if job and job.done and job.error is None and os.path.isfile(job.final):
            return None                  # 刚下载完并已改名
        job = Job(key, url, ext)
        _jobs[key] = job
        t = threading.Thread(target=job._run, name=f"castdl-{key}", daemon=True)
        job.thread = t
        t.start()
        return job


def drop_job(ncm_id):
    """下载失败后允许下次请求重新触发（否则会一直复用失败的任务）。"""
    with _lock:
        j = _jobs.get(int(ncm_id))
        if j and j.done and j.error:
            _jobs.pop(int(ncm_id), None)


def mime_of(ext):
    return {
        "flac": "audio/flac", "mp3": "audio/mpeg", "m4a": "audio/mp4",
        "aac": "audio/aac", "wav": "audio/wav", "ogg": "audio/ogg",
        "ape": "audio/x-ape",
    }.get((ext or "").lower(), "application/octet-stream")


def stats():
    try:
        names = [n for n in os.listdir(CACHE_DIR) if not n.endswith(".part")]
        size = sum(os.path.getsize(os.path.join(CACHE_DIR, n)) for n in names)
        with _lock:
            running = sum(1 for j in _jobs.values() if not j.done)
        return {"files": len(names), "bytes": size, "dir": CACHE_DIR, "running": running}
    except OSError:
        return {"files": 0, "bytes": 0, "dir": CACHE_DIR, "running": 0}
