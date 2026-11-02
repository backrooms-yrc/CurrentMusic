#!/usr/bin/env python3
"""CurrentStation 通行证端到端冒烟测试。

起一个**临时库**的服务实例再跑，避免污染线上数据：

    CM_DB=/tmp/pp.db CM_PORT=3099 python3 backend/cm_server.py &
    CM_DB=/tmp/pp.db python3 tools/passport-smoke.py http://127.0.0.1:3099

覆盖：元信息/文档页、应用登记、授权码 + PKCE、userinfo、鉴权与越权、
码重放、错误 verifier、刷新轮换、introspect、revoke、授权管理与撤销、
单点登出、scope 上限、公开客户端强制 PKCE、令牌端点限流。
退出码 0 = 全部通过。
"""
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3010").rstrip("/")
# 线上经 nginx 的路径是 /cm/passport/*（nginx 会把前缀剥掉再转给后端）；
# 直连后端调试时没有前缀 —— 两种都支持，启动时探测一次。
API = BASE + "/cm"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import cm_db  # noqa: E402  （用同一个 CM_DB 造测试账号）

PASSED, FAILED = [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"   {detail}" if detail and not cond else ""))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def req(method, path, body=None, token=None, basic=None, raw=False, follow_redirects=True):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    if basic:
        r.add_header("Authorization", "Basic " + base64.b64encode(basic.encode()).decode())
    try:
        opener = urllib.request.build_opener() if follow_redirects else urllib.request.build_opener(NoRedirect())
        with opener.open(r, timeout=15) as resp:
            body_raw = resp.read()
            return resp.status, (body_raw.decode("utf-8", "replace") if raw else json.loads(body_raw or b"{}"))
    except urllib.error.HTTPError as e:
        body_raw = e.read()
        try:
            return e.code, json.loads(body_raw or b"{}")
        except Exception:  # noqa: BLE001
            return e.code, {"raw": body_raw.decode("utf-8", "replace")[:200]}


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def pkce():
    v = b64url(os.urandom(32))
    return v, b64url(hashlib.sha256(v.encode()).digest())


PHONES = {"pp_admin": "13800008001", "pp_user": "13800008002", "pp_user2": "13800008003"}


def ensure_user(username, password, admin=False):
    u = cm_db.get_user_by_name(username)
    if not u:
        uid = cm_db.create_user(username, password, username + "（测试）",
                                email=username + "@example.com",
                                phone=PHONES.get(username, ""))
        u = cm_db.get_user(uid)
    if admin and not (u.get("is_admin") or u.get("is_super")):
        cm_db.set_admin(u["id"], True)
        u = cm_db.get_user(u["id"])
    return u


def detect_api():
    """探测前缀：/cm（经 nginx）还是空（直连后端）。"""
    global API
    for prefix in ("/cm", ""):
        st, _ = req("GET", BASE + prefix + "/passport/meta")   # 必须用绝对地址：req 会用 API 拼相对路径
        if st == 200:
            API = BASE + prefix
            return
    API = BASE + "/cm"


def reset_test_data(uids):
    """清掉上次跑留下的测试应用/授权（同一库重复跑也能过）。"""
    conn = cm_db.connect()
    try:
        keys = [r["key"] for r in conn.execute("SELECT key FROM passport_apps")]
        for k in keys:
            owner = conn.execute("SELECT owner_uid FROM passport_apps WHERE key=?", (k,)).fetchone()
            if owner and owner["owner_uid"] in uids:
                conn.execute("DELETE FROM passport_grants WHERE app_key=?", (k,))
                conn.execute("DELETE FROM passport_apps WHERE key=?", (k,))
        conn.execute("DELETE FROM passport_grants WHERE uid IN (%s)"
                     % ",".join("?" * len(uids)), tuple(uids))
        conn.commit()
    finally:
        conn.close()


def main():
    detect_api()
    print(f"== CurrentStation 通行证冒烟测试 @ {API}\n")
    # 0) 造账号：一个管理员（登记应用）+ 一个普通用户（走授权）
    reset_test_data([u["id"] for u in (
        ensure_user("pp_admin", "pass-Admin-1", admin=True),
        ensure_user("pp_user", "pass-User-1"),
        ensure_user("pp_user2", "pass-User-2"))])
    admin = ensure_user("pp_admin", "pass-Admin-1", admin=True)
    user = ensure_user("pp_user", "pass-User-1")
    other = ensure_user("pp_user2", "pass-User-2")
    _, r = req("POST", "/auth/login", {"username": "pp_admin", "password": "pass-Admin-1"})
    admin_tok = r.get("token", "")
    _, r = req("POST", "/auth/login", {"username": "pp_user", "password": "pass-User-1"})
    user_tok = r.get("token", "")
    _, r = req("POST", "/auth/login", {"username": "pp_user2", "password": "pass-User-2"})
    other_tok = r.get("token", "")
    check("测试账号登录（管理员 + 两个普通用户）", bool(admin_tok and user_tok and other_tok))

    # 1) 元信息与文档页
    st, meta = req("GET", "/passport/meta")
    check("GET /passport/meta 返回端点表", st == 200 and "token" in (meta.get("endpoints") or {}), str(meta)[:120])
    st, _ = req("GET", "/passport/docs", follow_redirects=False)
    check("GET /passport/docs 跳转到统一文档站", st == 302)
    st, dev = req("GET", "/developer", raw=True)
    check("GET /developer 返回独立开发者平台页", st == 200 and "CurrentDeveloper" in dev and "csdev.token" in dev)
    check("开发者平台与音乐客户端存储隔离（不读写 cm.token）",
          "/cm.token" not in dev and "cm.token" not in dev, "页面里出现了 cm.token")

    # 2) 应用登记
    st, app = req("POST", "/passport/apps", {
        "name": "冒烟测试应用", "redirects": ["https://example.com/cb"],
        "scopes": "openid profile email offline_access", "homepage": "https://example.com"}, token=admin_tok)
    cid, csec = app.get("clientId", ""), app.get("clientSecret", "")
    check("POST /passport/apps 登记应用（返回密钥一次）", st == 201 and cid and csec, str(app)[:160])
    st, _ = req("POST", "/passport/apps", {"name": "x", "redirects": ["http://evil.com/cb"]}, token=admin_tok)
    check("拒绝非 https 回调地址", st == 400)
    st, _ = req("POST", "/passport/apps", {"name": "x", "redirects": ["http://evil.com/cb"]}, token=user_tok)
    check("普通用户创建时同样拒绝非 https 回调", st == 400)

    # 2b) CurrentDeveloper 开发者平台：自助登记 / 权限隔离 / 配额 / 密钥轮换
    st, uapp = req("POST", "/passport/apps", {
        "name": "用户自助应用", "redirects": ["https://myapp.example.com/cb"],
        "scopes": "openid profile", "homepage": "https://myapp.example.com"}, token=user_tok)
    ucid, ucsec = uapp.get("clientId", ""), uapp.get("clientSecret", "")
    check("普通用户可自助登记应用（开发者平台）", st == 201 and ucid and ucsec, str(uapp)[:140])
    st, _ = req("PUT", f"/passport/apps/{ucid}", {"name": "管理员改名"}, token=admin_tok)
    check("管理员可管理他人应用", st == 200)
    st, _ = req("PUT", f"/passport/apps/{ucid}", {"name": "别人偷改"}, token=other_tok)
    check("别人不能改我的应用（403）", st == 403)
    st, _ = req("DELETE", f"/passport/apps/{ucid}", token=other_tok)
    check("别人不能停用我的应用（403）", st == 403)
    st, lst = req("GET", "/passport/apps", token=other_tok)
    check("应用列表只返回自己的", st == 200 and all(a["clientId"] != ucid for a in (lst.get("apps") or [])),
          str(lst)[:140])
    st, lst = req("GET", "/passport/apps?all=1", token=other_tok)
    check("非管理员的 ?all=1 不越权", st == 200 and all(a["clientId"] != ucid for a in (lst.get("apps") or [])))

    created, last = 0, None
    for i in range(8):
        st, _r = req("POST", "/passport/apps", {"name": f"配额{i}",
                                                "redirects": [f"https://q{i}.example.com/cb"],
                                                "scopes": "openid"}, token=user_tok)
        last = st
        if st == 201:
            created += 1
        elif st == 429:
            break
        else:
            break
    check("超出每账号应用数上限被拒（429）", last == 429, f"created={created} last={last}")

    st, rot = req("POST", f"/passport/apps/{ucid}/secret", {}, token=user_tok)
    newsec = rot.get("clientSecret", "")
    check("轮换 client_secret", st == 200 and newsec and newsec != ucsec, str(rot)[:120])
    st, _ = req("POST", "/passport/token", {"grant_type": "client_credentials", "client_id": ucid,
                                            "client_secret": ucsec, "scope": "openid"})
    check("旧密钥立即失效（401）", st == 401)
    st, cc2 = req("POST", "/passport/token", {"grant_type": "client_credentials", "client_id": ucid,
                                              "client_secret": newsec, "scope": "openid"})
    check("新密钥可换应用令牌", st == 200 and cc2.get("access_token", "").startswith("cs_at_"), str(cc2)[:120])
    # 换另一个账号建公开客户端（上一个账号已到配额上限），再切机密
    st, pub2 = req("POST", "/passport/apps", {"name": "公开转机密",
                                              "redirects": ["https://p2.example.com/cb"],
                                              "scopes": "openid profile", "public": True}, token=other_tok)
    pcid2 = pub2.get("clientId", "")
    check("登记公开客户端（开发者平台，无密钥）", st == 201 and pcid2 and not pub2.get("clientSecret"),
          str(pub2)[:120])
    st, up = req("PUT", f"/passport/apps/{pcid2}", {"public": False}, token=other_tok)
    check("公开客户端可切到机密（返回新密钥一次）", st == 200 and up.get("clientSecret"), str(up)[:120])

    # 3) 授权页：参数校验
    v1, c1 = pkce()
    q = (f"/passport/authorize?response_type=code&client_id={cid}"
         f"&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&scope=openid%20profile"
         f"&state=xyz&code_challenge={c1}&code_challenge_method=S256")
    st, info = req("GET", q, token=user_tok)
    check("GET /passport/authorize 返回同意页数据", st == 200 and info.get("app", {}).get("name") == "冒烟测试应用", str(info)[:160])
    st, _ = req("GET", q, token=None)
    check("未登录访问授权页 → 401", st == 401)
    st, _ = req("GET", q.replace("%2Fcb", "%2Fcb-evil"), token=user_tok)
    check("未登记回调地址被拒（400，不重定向）", st == 400)
    st, _ = req("GET", q.replace("openid%20profile", "openid%20phone"), token=user_tok)
    check("超出应用 scope 上限 → invalid_scope", st == 400)

    # 4) 批准 → 换令牌
    st, ok = req("POST", "/passport/authorize", {
        "client_id": cid, "redirect_uri": "https://example.com/cb",
        "scope": "openid profile email", "state": "xyz",
        "code_challenge": c1, "code_challenge_method": "S256", "approve": True}, token=user_tok)
    redirect = ok.get("redirect", "")
    check("批准后返回带 code 的回调地址", st == 200 and "code=" in redirect and "state=xyz" in redirect, redirect[:120])
    code = redirect.split("code=")[1].split("&")[0]

    st, tok = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": csec,
        "code": code, "redirect_uri": "https://example.com/cb", "code_verifier": v1})
    at, rt, sub = tok.get("access_token", ""), tok.get("refresh_token", ""), tok.get("sub", "")
    check("code 换令牌成功（含 refresh，因申请了 email 但未申请 offline_access？）",
          st == 200 and at.startswith("cs_at_") and sub.startswith("cs_"), str(tok)[:160])
    check("未申请 offline_access 时不发 refresh_token", rt == "", f"rt={rt[:20]}")

    # 5) 用户信息
    st, ui = req("GET", "/passport/userinfo", token=at)
    check("userinfo 返回 sub/昵称/脱敏邮箱",
          st == 200 and ui.get("sub") == sub and ui.get("nickname") and "***" in (ui.get("email") or ""), str(ui)[:160])
    st, _ = req("GET", "/passport/userinfo", token="cs_at_bogus")
    check("伪造令牌 → 401", st == 401)

    # 6) 重放与错误 verifier
    st, _ = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": csec,
        "code": code, "redirect_uri": "https://example.com/cb", "code_verifier": v1})
    check("同一 code 重放被拒", st == 400)

    v2, c2 = pkce()
    st, ok = req("POST", "/passport/authorize", {
        "client_id": cid, "redirect_uri": "https://example.com/cb", "scope": "openid profile",
        "state": "s2", "code_challenge": c2, "code_challenge_method": "S256", "approve": True}, token=user_tok)
    code2 = ok["redirect"].split("code=")[1].split("&")[0]
    st, _ = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": csec,
        "code": code2, "redirect_uri": "https://example.com/cb", "code_verifier": "wrong-verifier-wrong-verifier-wrong-verifier"})
    check("PKCE verifier 不匹配被拒", st == 400)
    st, _ = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": "cs_sk_wrong",
        "code": code2, "redirect_uri": "https://example.com/cb", "code_verifier": v2})
    check("client_secret 错误被拒（401）", st == 401)
    st, _ = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": csec,
        "code": code2, "redirect_uri": "https://other.example.com/cb", "code_verifier": v2})
    check("换令牌时 redirect_uri 不一致被拒", st == 400)

    # 7) 公开客户端必须 PKCE
    st, pub = req("POST", "/passport/apps", {
        "name": "公开客户端", "redirects": ["https://spa.example.com/cb"],
        "scopes": "openid profile", "public": True}, token=admin_tok)
    pcid = pub.get("clientId", "")
    check("登记公开客户端（无密钥）", st == 201 and pcid and not pub.get("clientSecret"), str(pub)[:120])
    st, _ = req("GET", f"/passport/authorize?response_type=code&client_id={pcid}"
                       "&redirect_uri=https%3A%2F%2Fspa.example.com%2Fcb&scope=openid", token=user_tok)
    check("公开客户端不带 PKCE 被拒（400）", st == 400)

    # 8) offline_access → refresh 轮换
    v3, c3 = pkce()
    st, ok = req("POST", "/passport/authorize", {
        "client_id": cid, "redirect_uri": "https://example.com/cb",
        "scope": "openid profile offline_access", "state": "s3",
        "code_challenge": c3, "code_challenge_method": "S256", "approve": True}, token=user_tok)
    code3 = ok["redirect"].split("code=")[1].split("&")[0]
    st, tok3 = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": csec,
        "code": code3, "redirect_uri": "https://example.com/cb", "code_verifier": v3})
    at3, rt3 = tok3.get("access_token", ""), tok3.get("refresh_token", "")
    check("offline_access → 返回 refresh_token", st == 200 and rt3.startswith("cs_rt_"), str(tok3)[:140])
    st, tok4 = req("POST", "/passport/token", {
        "grant_type": "refresh_token", "client_id": cid, "client_secret": csec, "refresh_token": rt3})
    check("refresh_token 换新令牌（轮换）", st == 200 and tok4.get("access_token") and tok4.get("refresh_token") != rt3,
          str(tok4)[:140])
    st, _ = req("POST", "/passport/token", {
        "grant_type": "refresh_token", "client_id": cid, "client_secret": csec, "refresh_token": rt3})
    check("旧 refresh_token 立即失效", st == 400)

    # 9) introspect / revoke
    st, ins = req("POST", "/passport/introspect", {"token": tok4["access_token"]}, basic=f"{cid}:{csec}")
    check("introspect 报告 active=true 且带 sub/scope",
          st == 200 and ins.get("active") is True and ins.get("sub") == sub and ins.get("scope"), str(ins)[:140])
    st, _ = req("POST", "/passport/introspect", {"token": tok4["access_token"]}, basic=f"{cid}:cs_sk_wrong")
    check("introspect 客户端认证失败 → 401", st == 401)
    st, _ = req("POST", "/passport/revoke", {"token": tok4["access_token"]}, basic=f"{cid}:{csec}")
    check("revoke 撤销令牌", st == 200)
    st, ins2 = req("POST", "/passport/introspect", {"token": tok4["access_token"]}, basic=f"{cid}:{csec}")
    check("撤销后 introspect active=false", st == 200 and ins2.get("active") is False)
    st, _ = req("GET", "/passport/userinfo", token=tok4["access_token"])
    check("撤销后 userinfo → 401", st == 401)

    # 10) 授权管理（用户侧）
    st, gl = req("GET", "/passport/grants", token=user_tok)
    apps = gl.get("grants") or []
    check("GET /passport/grants 列出已授权应用", st == 200 and any(g["clientId"] == cid for g in apps), str(gl)[:140])
    gid = next((g["id"] for g in apps if g["clientId"] == cid), "")
    st, _ = req("DELETE", f"/passport/grants/{gid}", token=user_tok)
    check("用户解除授权", st == 200)
    st, _ = req("GET", "/passport/userinfo", token=at)
    check("解除授权后此前令牌失效", st == 401)

    # 11) client_credentials + userinfo 拒绝
    st, cc = req("POST", "/passport/token", {"grant_type": "client_credentials", "scope": "openid"},
                 basic=f"{cid}:{csec}")
    check("client_credentials 发应用令牌", st == 200 and cc.get("access_token", "").startswith("cs_at_"), str(cc)[:140])
    st, _ = req("GET", "/passport/userinfo", token=cc["access_token"])
    check("应用令牌访问 userinfo → 403", st == 403)

    # 12) 单点登出：同一会话发出的授权随会话撤销
    v4, c4 = pkce()
    st, ok = req("POST", "/passport/authorize", {
        "client_id": cid, "redirect_uri": "https://example.com/cb", "scope": "openid profile",
        "state": "s4", "code_challenge": c4, "code_challenge_method": "S256", "approve": True}, token=user_tok)
    code4 = ok["redirect"].split("code=")[1].split("&")[0]
    st, tok5 = req("POST", "/passport/token", {
        "grant_type": "authorization_code", "client_id": cid, "client_secret": csec,
        "code": code4, "redirect_uri": "https://example.com/cb", "code_verifier": v4})
    at5 = tok5.get("access_token", "")
    st, _ = req("GET", "/passport/userinfo", token=at5)
    check("单点登出前令牌可用", st == 200)
    st, _ = req("POST", "/auth/logout", token=user_tok)
    check("用户登出（撤销会话）", st == 200)
    st, _ = req("GET", "/passport/userinfo", token=at5)
    check("单点登出：该会话发出的通行证令牌立即失效", st == 401)

    # 13) 令牌端点限流
    limited = False
    for _ in range(40):
        st, r = req("POST", "/passport/token", {"grant_type": "authorization_code", "client_id": cid,
                                                "client_secret": csec, "code": "cs_code_x"})
        if st == 429:
            limited = True
            break
    check("令牌端点限流（429）", limited)

    # 14) 审计
    _, r = req("POST", "/auth/login", {"username": "pp_admin", "password": "pass-Admin-1"})
    admin_tok = r.get("token", "")
    st, ev = req("GET", "/passport/events?limit=50", token=admin_tok)
    kinds = {e["kind"] for e in (ev.get("events") or [])}
    check("审计流水记录关键动作", st == 200 and {"app.create", "authorize.approve", "token.issue"} <= kinds,
          str(sorted(kinds))[:160])

    print(f"\n== 通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("失败项：" + "、".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
