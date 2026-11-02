"""受限的出站 HTTP 抓取（防 SSRF）。

只允许明确白名单的图片源；**不跟随重定向**、不走环境代理、限制读取字节。
分享图封面与 /img 代理都走这里：此前分享图直接对用户可控的 pic 调
urlopen，攻击者可让服务端访问 127.0.0.1 / 云元数据等内部地址。
"""
from __future__ import annotations

import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_BYTES = 8 * 1024 * 1024


class FetchError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None          # 3xx 交给 HTTPError，绝不跟到未知主机


def _check(url: str, allowed_suffixes) -> str:
    try:
        p = urlsplit(str(url or "").strip())
        port = p.port
        host = p.hostname
    except ValueError as e:
        raise FetchError("图片地址格式非法") from e
    if p.scheme not in ("http", "https") or not host:
        raise FetchError("只允许 http/https 图片地址")
    if p.username or p.password:
        raise FetchError("图片地址不允许携带凭据")
    host = host.lower().rstrip(".")
    if not host:
        raise FetchError("图片地址缺少主机")
    if port not in (None, 80, 443):
        raise FetchError("图片地址端口不允许")
    if allowed_suffixes:
        ok = any(host == s or host.endswith("." + s) for s in allowed_suffixes)
        if not ok:
            raise FetchError("图片源不在白名单内")
    return p.geturl()


def fetch(url: str, allowed_suffixes, timeout: float = 8.0, max_bytes: int = MAX_BYTES):
    """抓取白名单图片，返回 (bytes, content_type)。失败抛 FetchError。"""
    if not allowed_suffixes:
        raise FetchError("未配置图片源白名单")
    target = _check(url, allowed_suffixes)
    opener = urllib.request.build_opener(
        _NoRedirect(), urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        target, headers={"User-Agent": "CurrentMusic/1.0 (+safe-image)"})
    try:
        with opener.open(req, timeout=timeout) as r:
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            data = r.read(max_bytes + 1)
    except FetchError:
        raise
    except Exception as e:  # noqa: BLE001
        raise FetchError(f"图片获取失败: {e}") from e
    if len(data) > max_bytes:
        raise FetchError("图片过大")
    return data, ctype
