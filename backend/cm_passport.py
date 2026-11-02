"""CurrentStation 通行证（统一登录平台）——协议层。

职责划分：
  · 本文件只放**协议与安全**相关的纯函数（scope 解析、PKCE 校验、令牌生成/哈希、
    回调地址匹配、令牌端点限流），不碰 HTTP、不碰 sqlite；
  · 数据存取在 cm_db.passport_*，路由与响应在 cm_server.py 的 /passport/* 一节。

对接方式：OAuth 2.0 授权码 + PKCE（RFC 6749 / 7636 / 7009 / 7662），
机密客户端（有 client_secret）可用 client_secret 代替 PKCE；公开客户端（App / 原生）
必须带 code_challenge。详细文档见 /api-docs/reference/guide-passport-api/ 与 docs/passport-api.md。
"""
import hashlib
import secrets
import threading
import time
from urllib.parse import urlsplit

# ---------- 参数 ----------

CODE_TTL = 60                 # 授权码有效期（秒）：只够一次跳转，短到重放窗口可忽略
ACCESS_TTL = 2 * 3600         # 访问令牌 2 小时
REFRESH_TTL = 30 * 86400      # 刷新令牌 30 天；每次刷新都轮换（旧的立即失效）
CLIENT_SECRET_BYTES = 32

# scope 目录：跨产品通用（openid/profile/email/phone/offline_access）；
# 产品专属 scope 直接加在这个表里，第三方申请不到未登记的 scope。
SCOPES = {
    "openid":         {"label": "登录身份", "desc": "把你的 CurrentStation 通行证标识（sub）告诉应用", "required": True},
    "profile":        {"label": "公开资料", "desc": "昵称、头像、个人简介", "required": False},
    "email":          {"label": "邮箱（脱敏）", "desc": "如 a***@qq.com，不会给出完整邮箱", "required": False},
    "phone":          {"label": "手机号（脱敏）", "desc": "如 138****8000，不会给出完整号码", "required": False},
    "offline_access": {"label": "长期授权", "desc": "允许应用在你不在线时刷新令牌（30 天）", "required": False},
}
DEFAULT_SCOPE = "openid profile"
GRANT_TYPES = ("authorization_code", "refresh_token", "client_credentials")
PKCE_METHODS = ("S256", "plain")     # plain 仅为兼容，文档里不推荐
TOKEN_ALPHABET_BYTES = 32


class PassportError(Exception):
    """协议错误：error 用 OAuth 的标准错误码，desc 给人类看（中文）。"""

    def __init__(self, error, desc="", status=400):
        super().__init__(desc or error)
        self.error, self.desc, self.status = error, desc, status


# ---------- 时间 / 令牌 ----------

def now():
    return int(time.time())


def new_token(kind="at"):
    """生成明文令牌：cs_at_/cs_rt_ 前缀便于日志里一眼分辨，也便于误泄露时被扫描到。"""
    return f"cs_{kind}_{secrets.token_urlsafe(TOKEN_ALPHABET_BYTES)}"


def new_client_id():
    return "cs_app_" + secrets.token_hex(6)


def new_client_secret():
    return "cs_sk_" + secrets.token_urlsafe(CLIENT_SECRET_BYTES)


def hash_token(t):
    """令牌/授权码/客户端密钥统一只存 sha256（高熵随机值，无需加盐慢哈希）。"""
    return hashlib.sha256((t or "").encode()).hexdigest()


def new_grant_id():
    return "csg_" + secrets.token_hex(8)


# ---------- scope ----------

def scope_names(raw):
    """规范化 scope 字符串：去重、保序、白名单过滤。"""
    out = []
    for s in str(raw or "").replace(",", " ").split():
        if s in SCOPES and s not in out:
            out.append(s)
    return out


def parse_scope(raw, allowed=None, app_scopes=None):
    """校验请求的 scope：必须全部已登记，且不超过应用被授予的 scope 上限。"""
    want = scope_names(raw) or scope_names(DEFAULT_SCOPE)
    bad = [s for s in str(raw or "").replace(",", " ").split() if s and s not in SCOPES]
    if bad:
        raise PassportError("invalid_scope", f"不支持的 scope：{','.join(bad)}")
    if app_scopes is not None:
        limit = set(scope_names(app_scopes))
        over = [s for s in want if s not in limit]
        if over:
            raise PassportError("invalid_scope", f"该应用无权申请：{','.join(over)}")
    if allowed is not None:
        over = [s for s in want if s not in set(allowed)]
        if over:
            raise PassportError("invalid_scope", f"当前请求不允许：{','.join(over)}")
    return " ".join(want)


def has_scope(scope, name):
    return name in scope_names(scope)


# ---------- PKCE / 客户端 ----------

def check_pkce(challenge, method, verifier):
    """校验 PKCE（RFC 7636 §4.6）。challenge 为空 = 机密客户端流程，不校验。"""
    if not challenge:
        return True
    if not verifier:
        raise PassportError("invalid_grant", "缺少 code_verifier")
    m = (method or "S256").upper()
    if m not in ("S256", "PLAIN"):
        raise PassportError("invalid_request", "code_challenge_method 只支持 S256")
    if m == "S256":
        import base64
        digest = hashlib.sha256(verifier.encode()).digest()
        got = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    else:
        got = verifier
    # 定长比较，避免时序侧信道
    return secrets.compare_digest(got, challenge)


def check_code_challenge(challenge, method):
    """发起授权时校验 challenge 形态（S256 必须是 43~128 位 base64url）。"""
    if not challenge:
        return "", ""
    m = (method or "S256").upper()
    if m not in ("S256", "PLAIN"):
        raise PassportError("invalid_request", "code_challenge_method 只支持 S256")
    if m == "S256":
        import re
        if not re.fullmatch(r"[A-Za-z0-9\-_]{43,128}", challenge):
            raise PassportError("invalid_request", "code_challenge 格式不正确（S256 需 43~128 位 base64url）")
    return challenge, m


# ---------- 回调地址 ----------

def redirect_match(app_redirects, uri):
    """回调地址必须**精确匹配**已登记项（不做通配，防开放重定向）。
    localhost / 127.0.0.1 允许 http（本机调试），其余必须 https。"""
    if not uri:
        return False
    try:
        sp = urlsplit(uri)
    except Exception:  # noqa: BLE001
        return False
    if sp.scheme not in ("http", "https") or not sp.netloc or sp.fragment:
        return False
    if sp.scheme == "http" and sp.hostname not in ("localhost", "127.0.0.1", "::1"):
        return False
    return uri in list(app_redirects or [])


# ---------- 令牌端点限流 ----------
# /passport/token 是唯一"能被暴力尝试"的端点（换码 / 刷令牌 / 猜密钥）。
# 这里按「客户端 + 来源 IP」做滑动窗口：正常客户端一次授权只换一两次令牌，
# 触发限流的基本只有误用与攻击。全局 300 次/分钟的粗限流在 cm_server 里。

_RL_LOCK = threading.Lock()
_RL_BUCKETS = {}
_RL_MAX = 30            # 窗口内最多 30 次
_RL_WINDOW = 60.0
_RL_KEEP = 4096         # 桶数量上限（防内存被刷爆）


def rate_limited(key):
    now_t = time.time()
    with _RL_LOCK:
        b = _RL_BUCKETS.get(key)
        if b is None:
            if len(_RL_BUCKETS) >= _RL_KEEP:
                for k in sorted(_RL_BUCKETS, key=lambda k: _RL_BUCKETS[k][-1])[: _RL_KEEP // 2]:
                    _RL_BUCKETS.pop(k, None)
            b = _RL_BUCKETS[key] = []
        while b and now_t - b[0] > _RL_WINDOW:
            b.pop(0)
        if len(b) >= _RL_MAX:
            return True
        b.append(now_t)
        return False


# ---------- 用户信息 ----------

def mask_email(v):
    s = str(v or "")
    if "@" not in s:
        return ""
    name, _, host = s.partition("@")
    return (name[:1] or "") + "***@" + host


def mask_phone(v):
    s = str(v or "")
    return s[:3] + "****" + s[-4:] if len(s) >= 7 else ""


def userinfo(user, scope, sub):
    """按 scope 裁剪用户信息（RFC 7662/OIDC 的习惯字段名）。"""
    out = {"sub": sub}
    if has_scope(scope, "profile"):
        out.update({
            "nickname": user.get("nickname") or "",
            "avatar": user.get("avatar") or "",
            "bio": user.get("bio") or "",
            "title": user.get("title") or "",      # 站内头衔（管理员授予；''=无）
            "created_at": user.get("created_at") or 0,
        })
    if has_scope(scope, "email"):
        out["email"] = mask_email(user.get("email"))
    if has_scope(scope, "phone"):
        out["phone"] = mask_phone(user.get("phone"))
    return out
