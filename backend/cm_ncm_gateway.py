"""NCM 泛化转发的运行时部件（阶段一）。

与 `cm_ncm_registry.py`（静态安全边界）分离：本模块只放**纯函数**与**有状态但无依赖**的
部件，便于单测；不 import cm_server，避免循环依赖。

职责：
  - 参数规范化：剥掉调用方注入的保留参数、按需补 timestamp
  - 缓存键：与参数顺序无关，避免同一请求因参数顺序不同而穿透缓存
  - 按接口族的熔断：单族故障不拖垮其它接口族（379 条接口放大故障面的前提）
"""
from __future__ import annotations

import base64
import hashlib
import threading
import time

# 调用方不得注入的保留参数（cookie 由网关按分级决定，token 是项目自身会话）。
# `confirm` 是网关的 T2 二次确认开关、`file` 是上传通道的文件体字段名，两者都只服务于
# 网关自身：后者若从 query 漏进上游，等于把几 MB 的 base64 塞进 URL。上游模块里没有
# 任何一处读 query.confirm / query.file（`query.fileSize` 这类不算），可安全剥离。
RESERVED_PARAMS = frozenset({"cookie", "token", "realIP", "randomCNIP", "confirm", "file"})

# 需要 multipart 上传的接口：上游路径 -> 表单字段名。
#
# 为什么单独一张表：上游这几个接口要的是 `multipart/form-data` 里的**文件**（如
# `/api/playlist/cover/update` 的 `imgFile`），而泛化转发默认只送 query 参数。
# 这张表是**白名单**——没登记在这里的路径一律不接受文件体，避免把通用转发变成任意上传通道。
# 值与登记表（cm_ncm_registry）叠加生效：仍然要过 tier/阶段门禁，T3 依旧 403。
UPLOAD_FIELD = {
    "/playlist/cover/update": "imgFile",
    "/avatar/upload": "imgFile",
    # 播客声音上传：上游要的是音频字段 songFile（另有可选封面 imgFile，
    # 本通道一次只带一个文件，所以先只支持音频本体；封面用上游默认图）
    "/voice/upload": "songFile",
    # 云盘的旧版一次性上传：上游直接吃 songFile（音频），自己做指纹与入库
    "/cloud": "songFile",
}

# 上传体积上限（解码后的字节数）。前端会先降采样，正常封面远小于此。
UPLOAD_MAX_BYTES = 3 * 1024 * 1024

# 允许的图片/音频类型：与上游 upload 插件接受的形态一致
UPLOAD_TYPES = frozenset({
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp",
    "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav",
})


def upload_field(path: str):
    """该路径是否接受文件上传；返回表单字段名（不在白名单则 None）。"""
    return UPLOAD_FIELD.get(path)


def decode_upload(body: dict, max_bytes: int = UPLOAD_MAX_BYTES):
    """把 JSON 体里的 base64 文件解出来。

    约定（前端 `api.ncmUpload` 负责生成）：
        { "file": "<base64>", "filename": "cover.jpg", "contentType": "image/jpeg" }

    只做**格式与体积**校验，不猜业务；类型不在白名单、体积超限、base64 非法都直接拒绝，
    绝不"尽力而为"地把未知字节转发给上游。
    """
    if not isinstance(body, dict):
        raise ValueError("上传体必须是 JSON 对象")
    raw = body.get("file")
    if not isinstance(raw, str) or not raw:
        raise ValueError("缺少 file（base64）字段")
    filename = str(body.get("filename") or "upload.bin")[:120]
    content_type = str(body.get("contentType") or "application/octet-stream").lower()
    if content_type not in UPLOAD_TYPES:
        raise ValueError(f"不支持的文件类型 {content_type}")
    # base64 的 4/3 膨胀：先按长度快速拒绝，避免把超大串整个解出来占内存
    if len(raw) > (max_bytes // 3 + 8) * 4:
        raise ValueError("文件过大")
    try:
        data = base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001 统一成可读错误
        raise ValueError("base64 解码失败") from exc
    if len(data) > max_bytes:
        raise ValueError("文件过大")
    if not data:
        raise ValueError("文件为空")
    return filename, content_type, data



def normalize_params(path: str, query: dict, method: str) -> dict:
    """把入参整理成可直接交给上游的形式。

    - 丢弃保留参数，防止调用方自带 cookie 越权 / 覆盖网关策略
    - 非 GET 补 `timestamp`，绕开上游 2 分钟 URL 级缓存（写操作必须实时）
    - 丢弃空值，避免上游把空串当成有效参数
    """
    out = {}
    for k, v in (query or {}).items():
        if k in RESERVED_PARAMS:
            continue
        if v is None or v == "":
            continue
        out[k] = v
    if method != "GET":
        out["timestamp"] = str(int(time.time() * 1000))
    return out


# 媒体地址族：上游要按调用方 IP 选 CDN 边缘（/song/url/v1 的文档参数 realIP），
# 返回的直链也要统一升 https（HTTPS 页面加载 http:// 音源会被浏览器当混合内容拦死）。
MEDIA_URL_PREFIXES = (
    "/song/url", "/song/download/url", "/mv/url", "/video/url",
    "/song/cloud/download", "/voice/detail",
)


def client_ip(handler) -> str:
    """取真实客户端 IP（喂给上游 realIP、按 IP 分缓存键与限速桶——取值链必须不可伪造）。

    取值优先级（两个头都由 nginx **覆盖/追加写入**，调用方自带的值不可信）：

      1. ``X-Real-IP``：nginx 用 ``$remote_addr`` 覆盖写入；
      2. ``X-Forwarded-For`` 的**最后一跳**：nginx 用 ``$proxy_add_x_forwarded_for``
         把真实对端追加在末尾（首值可能是调用方自己写的，不能信）；
      3. 兜底 ``client_address[0]``。

    旧实现取 CF-Connecting-IP → XFF **首值**：CF 关闭的部署下这两个头无人覆盖、
    可被调用方伪造（实测伪造 XFF 首值即可让上游按任意 IP 挑边缘、绕过按 IP 的
    限速桶）。v1.28.24 起与 :func:`rate_key` 并入同一实现。

    ⚠️ ``CF-Connecting-IP`` **刻意不在链上**：只有 Cloudflare 在前时它才被 CF 覆盖
    写入、可信；CF 关闭时它只是个原样透传的普通请求头，放进链条就等于留了个
    伪造后门。若将来重开 Cloudflare：把它加回第 1 位，**同时**注意 X-Real-IP 会
    变成 CF 边缘节点的 IP（nginx 看到的对端是 CF），需要一并调整。
    """
    ip = (handler.headers.get("X-Real-IP") or "").strip()
    if ip:
        return ip
    xff = handler.headers.get("X-Forwarded-For", "")
    if xff:
        last = xff.split(",")[-1].strip()
        if last:
            return last
    return handler.client_address[0]


def rate_key(handler) -> str:
    """限速用的调用方标识 = 真实客户端 IP（与 :func:`client_ip` 同一条取值链）。

    历史注记：本函数先于 client_ip 完成加固——旧 client_ip 取 XFF 首值/CF 头，
    在 CF 关闭时可伪造；v1.28.24 起两函数合一，修 client_ip 即同时修限速。
    """
    return client_ip(handler)


def is_media_url_path(path: str) -> bool:
    """是否媒体地址族（要传 realIP、要升 https）。"""
    return any(path == p or path.startswith(p + "/") or path.startswith(p + "?")
               for p in MEDIA_URL_PREFIXES)


def should_forward_real_ip(path: str, method: str, tier: int) -> bool:
    """是否把可信客户端 IP 作为 realIP 交给上游。

    - 媒体地址族：GET 也要，用于挑选就近 CDN 边缘；
    - 账号写操作（T2/T3 且非 GET）：用于网易云风控与评论 IP 属地。
    - 公共只读缓存接口（T0/T1 GET）不传，避免缓存按 IP 碎片化和无谓的隐私暴露。
    """
    return is_media_url_path(path) or (method != "GET" and int(tier or 0) >= 2)


def https_upgrade(obj):
    """把响应里的 http://*.126.net 直链升成 https://（NCM CDN 实测双协议可用）。

    只动 126.net 域，避免误伤上游返回的第三方 http 链接（那些可能真不支持 https）。
    """
    if isinstance(obj, str):
        low = obj.find("http://")
        if low >= 0 and ".126.net/" in obj:
            return obj[:low] + obj[low:].replace("http://", "https://", 1)
        return obj
    if isinstance(obj, dict):
        return {k: https_upgrade(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [https_upgrade(v) for v in obj]
    return obj


def cache_key(path: str, params: dict) -> str:
    """与参数顺序无关的缓存键。"""
    items = "&".join(f"{k}={params[k]}" for k in sorted(params))
    digest = hashlib.sha1(items.encode("utf-8")).hexdigest()[:16]
    return f"ncmgw:{path}:{digest}"


class FamilyBreaker:
    """按接口族的连续失败熔断。

    - `threshold` 次连续失败 → 该族熔断 `cooldown` 秒
    - 熔断期间该族直接快速失败，**其它族不受影响**
    - 成功一次即清零

    为什么按族：P1 之后会放量到数百条接口，全局熔断会让一个坏接口拖垮整个 App。
    """

    def __init__(self, threshold: int = 5, cooldown: float = 60.0):
        self.threshold = threshold
        self.cooldown = cooldown
        self._lock = threading.Lock()
        self._state: dict = {}  # family -> (fail_count, opened_at)

    def allow(self, family: str) -> bool:
        now = time.monotonic()
        with self._lock:
            fails, opened = self._state.get(family, (0, 0.0))
            if opened and now - opened < self.cooldown:
                return False
            if opened:  # 冷却结束，半开：放行一次探测
                self._state[family] = (0, 0.0)
            return True

    def record_success(self, family: str) -> None:
        with self._lock:
            self._state.pop(family, None)

    def record_failure(self, family: str) -> None:
        now = time.monotonic()
        with self._lock:
            fails, opened = self._state.get(family, (0, 0.0))
            if opened and now - opened >= self.cooldown:
                fails, opened = 0, 0.0
            fails += 1
            if fails >= self.threshold:
                self._state[family] = (fails, now)
            else:
                self._state[family] = (fails, opened)

    def status(self) -> dict:
        """供 /admin/ncm 面板展示。"""
        now = time.monotonic()
        with self._lock:
            return {
                fam: {"fails": f, "open": bool(o and now - o < self.cooldown)}
                for fam, (f, o) in self._state.items()
            }
