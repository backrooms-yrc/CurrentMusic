"""HTTP boundary between CurrentMusic and the local QQ Music API."""
from dataclasses import dataclass
from hashlib import sha256
from http.client import HTTPConnection, HTTPException
import ipaddress
import json
import logging
import os
import re
import threading
import time
from urllib.parse import urlencode, urlsplit

import cm_db
import cm_qq_catalog
import cm_qq_registry as registry

log = logging.getLogger("cm.qqmusic")
BASE = os.environ.get("CM_QQ_MUSIC_BASE", "").strip()
MAX_RESPONSE = 8 * 1024 * 1024
COOKIE = "qqmusic_session"
SESSION = re.compile(r"[0-9a-f]{64}")
QR_KEY = re.compile(r"[0-9a-f]{48}")
QR_TTL = 240  # Three minutes upstream, plus its confirmed-result grace period.
CREDENTIAL_FIELDS = frozenset({
    "cookie", "token", COOKIE, "x-qq-session", "authorization",
    "musickey", "qm_keyst", "qqmusic_key", "refresh_token",
})
_QR_LOCK = threading.Lock()
_qr = None
_qr_completed = {}


@dataclass(frozen=True)
class PendingQR:
    user: int
    key: str
    deadline: float
    channel: str


class Error(Exception):
    def __init__(self, status, message, *, key=None):
        super().__init__(message)
        self.status = status
        self.body = {"error": message}
        if key:
            self.body["errorKey"] = key


def is_path(path):
    return path == registry.PREFIX or path.startswith(registry.PREFIX + "/")


def _address():
    if not BASE:
        raise Error(503, "QQ 音乐暂未启用")
    try:
        url = urlsplit(BASE)
        if (url.scheme != "http" or not ipaddress.ip_address(url.hostname).is_loopback
                or url.username is not None or url.password is not None
                or url.path not in ("", "/") or url.query or url.fragment):
            raise ValueError
        return url.hostname, url.port or 80
    except (TypeError, ValueError):
        raise Error(503, "QQ 音乐上游配置无效") from None


def call(method, path, query=None, body=None, session=None):
    address = _address()
    headers = {"Accept": "application/json"}
    if session:
        headers["X-QQ-Session"] = session
    data = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        data = json.dumps(body if body is not None else {}, ensure_ascii=False).encode()
    target = path + ("?" + urlencode(query) if query else "")
    conn = HTTPConnection(*address, timeout=25 if path.startswith(("/login/", "/getMusicPlay")) else 8)
    try:
        conn.request(method, target, body=data, headers=headers)
        response = conn.getresponse()
        status = response.status
        retry = response.getheader("Retry-After", "")
        retry_header = {"Retry-After": retry} if re.fullmatch(r"[0-9]{1,6}", retry) else {}
        if status in (502, 503, 504):
            raise Error(status, "QQ 音乐上游暂不可用")
        if not (200 <= status < 300 or 400 <= status < 500):
            raise Error(502, "QQ 音乐上游响应异常")
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise Error(502, "QQ 音乐上游响应过大")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise Error(502, "QQ 音乐上游响应格式错误")
        return status, result, retry_header
    except TimeoutError:
        raise Error(504, "QQ 音乐上游请求超时") from None
    except (OSError, HTTPException, ValueError, RecursionError):
        raise Error(502, "QQ 音乐上游请求失败") from None
    finally:
        conn.close()


def _credentials_in(value):
    if isinstance(value, dict):
        return any(key.lower() in CREDENTIAL_FIELDS or _credentials_in(item)
                   for key, item in value.items())
    return isinstance(value, list) and any(_credentials_in(item) for item in value)


def _session(handler):
    headers = handler.headers
    values = headers.get_all("X-QQ-Session", [])
    cookies = [value.strip() for line in headers.get_all("Cookie", [])
               for entry in line.split(";") for key, sep, value in [entry.partition("=")]
               if sep and key.strip() == COOKIE]
    if len(values) > 1 or len(cookies) > 1:
        raise Error(400, "QQ 会话凭据重复")
    token = values[0].strip() if values else cookies[0] if cookies else None
    if token is not None and not SESSION.fullmatch(token):
        raise Error(401, "QQ 会话无效，请重新扫码")
    return token, bool(cookies and not values)


def _cookie(token="", age=0):
    return f"{COOKIE}={token}; Max-Age={age}; Path=/cm/qqmusic/; Secure; HttpOnly; SameSite=Lax"


def _digest(session):
    return sha256(session.encode("ascii")).hexdigest()


def _claim_session(token, user):
    if not cm_db.claim_qq_session(_digest(token), user):
        raise Error(403, "此 QQ 会话属于其他站内账号")


def _qr_session(path, user, body):
    global _qr
    if not _QR_LOCK.acquire(blocking=False):
        raise Error(409, "已有 QQ 扫码操作进行中")
    try:
        now = time.monotonic()
        if _qr and _qr.deadline <= now:
            _qr = None
        for key, (_, deadline) in list(_qr_completed.items()):
            if deadline <= now:
                del _qr_completed[key]
        if path.endswith("/key"):
            channel = body.get("channel", "qq")
            if channel not in ("qq", "wechat", "qqmusic", "mobile"):
                raise Error(400, "QQ 扫码通道无效")
            if _qr:
                if (_qr.user, _qr.channel) == (user, channel):
                    return 200, {"code": 200, "data": {"unikey": _qr.key}}, {}
                raise Error(409, "已有 QQ 扫码登录进行中")
            status, result, headers = call("GET", path, {"channel": channel})
            if status != 200:
                return status, result, headers
            key = (result.get("data") or {}).get("unikey")
            if not isinstance(key, str) or not QR_KEY.fullmatch(key):
                raise Error(502, "QQ 音乐未返回有效的二维码标识")
            _qr = PendingQR(user, key, time.monotonic() + QR_TTL, channel)
            return status, result, headers

        key = body.get("key")
        if not isinstance(key, str) or not QR_KEY.fullmatch(key):
            raise Error(400, "缺少有效的二维码标识")
        active = _qr is not None and (_qr.user, _qr.key) == (user, key)
        checking = path.endswith("/check")
        if not active and not (checking and _qr_completed.get(key, (None, 0))[0] == user):
            raise Error(404, "二维码已过期或不存在")
        status, result, headers = call("GET", path, {"key": key})
        if checking and result.get("code") == 803 and status == 200:
            raw = result.get("cookie")
            token = raw.removeprefix(COOKIE + "=") if isinstance(raw, str) else ""
            if not SESSION.fullmatch(token):
                raise Error(502, "QQ 音乐未返回有效的个人会话")
            _claim_session(token, user)
            if active:
                _qr = None
                _qr_completed[key] = (user, time.monotonic() + 60)
            return 200, {"code": 803, "data": {"session": token}}, {"Set-Cookie": _cookie(token, 86400)}
        if active and ((path.endswith("/cancel") and status == 200) or result.get("code") == 800):
            _qr = None
        elif result.get("code") == 800:
            _qr_completed.pop(key, None)
        return status, result, headers
    finally:
        _QR_LOCK.release()


def _verify_session(session):
    status, result, headers = call("GET", "/login/status", session=session)
    if status != 200:
        return status, result, headers
    profile = (result.get("data") or {}).get("profile")
    if not isinstance(profile, dict) or not profile:
        raise Error(401, "QQ 会话无效，请重新扫码")
    return status, result, headers


def dispatch(handler, method, path, query, body, authenticate):
    relative = path[len(registry.PREFIX):]
    route = registry.match(relative)
    if route is None:
        raise Error(404, "QQ 音乐接口不存在")
    if method != route.method:
        return 405, {"error": "请求方法不受支持"}, {"Allow": route.method}
    if method == "POST" and not isinstance(body, dict):
        raise Error(400, "请求体必须是 JSON 对象")
    if _credentials_in(query) or _credentials_in(body):
        raise Error(400, "请通过请求头或 qqmusic_session Cookie 传递 QQ 会话")

    session, from_cookie = _session(handler) if route.auth in (registry.PRIVATE, registry.WRITE, registry.OPTIONAL) else (None, False)
    if route.auth == registry.OPTIONAL and from_cookie and not handler.headers.get("Authorization"):
        session = None
    user = None
    if route.auth in (registry.LOGIN, registry.PRIVATE, registry.WRITE) or session:
        user = authenticate(handler)["id"]
    if route.auth in (registry.PRIVATE, registry.WRITE) and not session:
        raise Error(401, "请先扫码登录 QQ 音乐")
    if session and not cm_db.qq_session_owned_by(_digest(session), user):
        raise Error(401, "QQ 会话与当前站内账号不匹配，请重新扫码")
    if method == "POST" and from_cookie and handler.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
        raise Error(403, "跨源写入请使用 X-QQ-Session")
    if route.auth == registry.WRITE:
        if str(body.get("confirm", query.get("confirm", ""))).lower() not in ("1", "true"):
            raise Error(400, "写操作需要二次确认（confirm=1）")
        log.info("QQ 写操作 user=%s route=%s", user, route.path)

    if relative.startswith("/login/qr/"):
        return _qr_session(route.upstream, user, body)
    if relative == "/login/status":
        return _verify_session(session)
    if relative == "/logout":
        status, result, headers = call("GET", route.upstream, session=session)
        if status == 200:
            cm_db.forget_qq_session(_digest(session), user)
            headers["Set-Cookie"] = _cookie()
        return status, result, headers
    if relative == "/login/refresh":
        status, result, headers = call("POST", route.upstream, session=session)
        token = (result.get("data") or {}).get("token")
        if status == 200 and isinstance(token, str) and SESSION.fullmatch(token):
            _claim_session(token, user)
            headers["Set-Cookie"] = _cookie(token, 86400)
        return status, result, headers
    if route.kind == "compat":
        return 200, cm_qq_catalog.read(relative, query, session, call, Error), {}
    if relative == "/native/mv/url":
        # QQ Music API can otherwise resolve an MV anonymously for an invalid session.
        status, result, headers = _verify_session(session)
        if status != 200:
            return status, result, headers
    upstream = relative.removeprefix("/native") if route.kind == "native" else route.upstream
    params = {key: val for key, val in query.items() if key != "confirm"}
    payload = {key: val for key, val in body.items() if key != "confirm"} if isinstance(body, dict) else None
    return call(method, upstream, params, payload, session)
