#!/usr/bin/env python3
"""站内头衔（管理员授予）+ 角色（站长 / 超管）端到端冒烟测试。

用**临时库**起一个实例再跑，避免污染线上数据：

    CM_DB=/tmp/title.db CM_PORT=3097 python3 backend/cm_server.py &
    CM_DB=/tmp/title.db python3 tools/title-smoke.py http://127.0.0.1:3097

覆盖：权限分级（普通用户 401/403、管理员可授予、低角色不能动高角色）、
长度与空白规整、清空头衔、广场/公开主页/帖子/评论/房间成员/通行证 userinfo
各处下发头衔与角色、广场排序（站长 > 超管 > 管理员）、超级管理员的授予与取消
（仅超管/站长）、站长授予与取消（仅站长）、对自己操作的拦截。
退出码 0 = 全部通过。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3010").rstrip("/")
API = BASE + "/cm"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import cm_db        # noqa: E402
import cm_passport  # noqa: E402
import cm_rooms     # noqa: E402

PASSED, FAILED = [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"   {detail}" if detail and not cond else ""))


def req(method, path, body=None, token=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:  # noqa: BLE001
            return e.code, {}


def detect_api():
    global API
    for prefix in ("/cm", ""):
        st, _ = req("GET", BASE + prefix + "/announcements")
        if st == 200:
            API = BASE + prefix
            return
    API = BASE + "/cm"


PHONES = {"tt_owner": "13800007100", "tt_admin": "13800007101",
          "tt_super": "13800007102", "tt_user": "13800007103"}


def ensure_user(username, password, admin=False, super_admin=False, owner=False):
    u = cm_db.get_user_by_name(username)
    if not u:
        uid = cm_db.create_user(username, password, username + "（头衔测试）",
                                email=username + "@example.com", phone=PHONES.get(username, ""))
        u = cm_db.get_user(uid)
    # 站长隐含超管+管理员（与 set_owner 一致）
    conn = cm_db.connect()
    conn.execute("UPDATE users SET is_admin=?, is_super=?, is_owner=?, public_square=1 WHERE id=?",
                 (1 if (admin or super_admin or owner) else 0,
                  1 if (super_admin or owner) else 0,
                  1 if owner else 0, u["id"]))
    conn.commit()
    conn.close()
    return cm_db.get_user(u["id"])


def login(username, password):
    _, r = req("POST", "/auth/login", {"username": username, "password": password})
    return r.get("token", "")


def main():
    detect_api()
    print(f"== 站内头衔 + 角色（站长/超管）冒烟测试 @ {API}\n")
    t_owner_u = ensure_user("tt_owner", "pass-Tt-0", owner=True)
    t_admin_u = ensure_user("tt_admin", "pass-Tt-1", admin=True)
    t_super_u = ensure_user("tt_super", "pass-Tt-2", super_admin=True)
    t_user_u = ensure_user("tt_user", "pass-Tt-3")
    # 起始状态：四个人都没有头衔
    for u in (t_owner_u, t_admin_u, t_super_u, t_user_u):
        cm_db.set_title(u["id"], "")
    tok_owner = login("tt_owner", "pass-Tt-0")
    tok_admin = login("tt_admin", "pass-Tt-1")
    tok_super = login("tt_super", "pass-Tt-2")
    tok_user = login("tt_user", "pass-Tt-3")
    check("测试账号登录（站长 + 管理员 + 超管 + 普通用户）",
          all([tok_owner, tok_admin, tok_super, tok_user]))

    uid, suid, oid = t_user_u["id"], t_super_u["id"], t_owner_u["id"]

    # ---------- 权限 ----------
    st, _ = req("POST", f"/admin/users/{uid}/title", {"title": "越权"}, token=None)
    check("未登录不能设置头衔（401）", st == 401, str(st))
    st, _ = req("POST", f"/admin/users/{uid}/title", {"title": "越权"}, token=tok_user)
    check("普通用户不能设置头衔（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{suid}/title", {"title": "改超管"}, token=tok_admin)
    check("普通管理员不能改超管的头衔（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{t_admin_u['id']}/super", {"on": True}, token=tok_user)
    check("普通用户不能授予超管（403）", st == 403, str(st))

    # ---------- 管理员授予 / 各处展示 ----------
    st, r = req("POST", f"/admin/users/{uid}/title", {"title": "首席体验官"}, token=tok_admin)
    check("管理员可设置普通用户头衔", st == 200 and r.get("title") == "首席体验官", f"{st} {r}")

    st, d = req("GET", f"/profile/{uid}")
    check("公开主页下发头衔", st == 200 and d.get("title") == "首席体验官", str(d)[:120])

    st, d = req("GET", "/users/square?" + urllib.parse.urlencode({"query": "tt_", "limit": 20}))
    hit = next((x for x in (d.get("users") or []) if x["id"] == uid), None)
    check("发现页广场用户列表下发头衔", st == 200 and hit and hit.get("title") == "首席体验官", str(hit)[:160])
    check("广场排序：站长 > 超管 > 管理员",
          st == 200 and [x["id"] for x in (d.get("users") or [])][:3] == [oid, suid, t_admin_u["id"]],
          str([x["id"] for x in (d.get("users") or [])]))

    st, d = req("POST", "/posts", {"content": "头衔展示测试帖", "attachments": []}, token=tok_user)
    pid = d.get("id")
    st2, d2 = req("GET", "/posts?limit=20")
    post = next((p for p in (d2.get("posts") or []) if p["id"] == pid), None)
    check("发现页帖子作者下发头衔",
          st == 200 and post and post["author"].get("title") == "首席体验官", str(post)[:200])

    st, _ = req("POST", f"/posts/{pid}/comments", {"content": "评论也带一个"}, token=tok_user)
    st2, d2 = req("GET", f"/posts/{pid}/comments")
    cmt = (d2.get("comments") or [{}])[0]
    check("帖子评论作者下发头衔（含站内角色）",
          st == 200 and cmt.get("author", {}).get("title") == "首席体验官"
          and "isAdmin" in cmt.get("author", {}), str(cmt)[:200])

    # 房间成员：list_members 走 users 表 join，头衔/站内角色都要带出来
    room = cm_rooms.create_room(uid, "头衔冒烟房")
    members = cm_rooms.list_members(room["id"], online_within=3600)
    owner_row = next((m for m in members if m["user_id"] == uid), None)
    check("听歌房成员列表下发头衔与站内角色",
          owner_row and owner_row.get("title") == "首席体验官" and owner_row.get("is_admin") == 0
          and owner_row.get("is_super") == 0, str(owner_row)[:200])

    # 通行证 userinfo（profile scope）也带出头衔
    uinfo = cm_passport.userinfo(cm_db.get_user(uid), "openid profile", "sub-test")
    check("通行证 userinfo（profile scope）下发头衔", uinfo.get("title") == "首席体验官", str(uinfo))

    # ---------- 规整与校验 ----------
    st, r = req("POST", f"/admin/users/{uid}/title", {"title": "  多  余\t空白\n和换行  "}, token=tok_admin)
    check("头衔空白/换行被规整", st == 200 and r.get("title") == "多 余 空白 和换行", str(r))
    st, _ = req("POST", f"/admin/users/{uid}/title", {"title": "字" * (cm_db.TITLE_MAX + 1)}, token=tok_admin)
    check(f"超过 {cm_db.TITLE_MAX} 字被拒（400）", st == 400, str(st))
    st, r = req("POST", f"/admin/users/{uid}/title", {"title": "字" * cm_db.TITLE_MAX}, token=tok_admin)
    check(f"正好 {cm_db.TITLE_MAX} 字可通过", st == 200 and len(r.get("title", "")) == cm_db.TITLE_MAX, str(r))

    st, r = req("POST", f"/admin/users/{uid}/title", {"title": ""}, token=tok_admin)
    check("留空可清空头衔", st == 200 and r.get("title") == "", str(r))
    st, d = req("GET", f"/profile/{uid}")
    check("清空后公开主页不再有头衔", d.get("title") == "", str(d)[:120])

    # 注入：头衔里的尖括号原样存储，由前端转义（后端不渲染 HTML）
    st, r = req("POST", f"/admin/users/{uid}/title", {"title": "<b>x</b>"}, token=tok_admin)
    check("头衔按纯文本存储（不吞不转义）", st == 200 and r.get("title") == "<b>x</b>", str(r))
    req("POST", f"/admin/users/{uid}/title", {"title": ""}, token=tok_admin)

    # ---------- 超级管理员 ----------
    st, _ = req("POST", "/admin/users/999999/title", {"title": "x"}, token=tok_super)
    check("对不存在的用户设置头衔（404）", st == 404, str(st))
    st, _ = req("POST", f"/admin/users/{uid}/super", {"on": True}, token=tok_admin)
    check("普通管理员不能授予超管（403）", st == 403, str(st))
    st, r = req("POST", f"/admin/users/{uid}/super", {"on": True}, token=tok_super)
    check("超管可授予他人超管", st == 200 and r.get("isSuper") is True, str(r))

    st, d = req("GET", "/admin/users?" + urllib.parse.urlencode({"query": "tt_user"}), token=tok_super)
    row = (d.get("users") or [{}])[0]
    check("授予超管同时置 is_admin=1（列表可见）", row.get("is_super") == 1 and row.get("is_admin") == 1, str(row)[:160])

    st, d = req("GET", f"/profile/{uid}")
    check("公开主页 isSuper 生效", d.get("isSuper") is True, str(d)[:120])

    # 现在 target 是超管：普通管理员改不了，超管可以
    st, _ = req("POST", f"/admin/users/{uid}/title", {"title": "再改"}, token=tok_admin)
    check("普通管理员不能改（新）超管的头衔（403）", st == 403, str(st))
    st, r = req("POST", f"/admin/users/{uid}/title", {"title": "超级头衔"}, token=tok_super)
    check("超管可改其他超管的头衔", st == 200 and r.get("title") == "超级头衔", str(r))

    st, _ = req("POST", f"/admin/users/{suid}/super", {"on": False}, token=tok_super)
    check("不能对自己执行超管操作（400）", st == 400, str(st))
    st, r = req("POST", f"/admin/users/{uid}/super", {"on": False}, token=tok_super)
    check("超管可取消他人超管", st == 200 and r.get("isSuper") is False, str(r))

    st, d = req("GET", "/admin/overview", token=tok_super)
    check("概览返回头衔长度上限（前端弹窗限长用）", st == 200 and d.get("titleMax") == cm_db.TITLE_MAX, str(d)[:120])

    # ---------- 站长（最高角色） ----------
    st, d = req("GET", f"/profile/{oid}")
    check("公开主页 isOwner 生效（且隐含超管）",
          st == 200 and d.get("isOwner") is True and d.get("isSuper") is True, str(d)[:120])
    st, d = req("GET", "/users/square?" + urllib.parse.urlencode({"query": "tt_owner", "limit": 5}))
    hit = (d.get("users") or [{}])[0]
    check("广场下发 isOwner（站长置顶第一）", st == 200 and hit.get("isOwner") is True, str(hit)[:160])

    st, _ = req("POST", f"/admin/users/{t_admin_u['id']}/owner", {"on": True}, token=tok_super)
    check("超管不能授予站长（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{uid}/owner", {"on": True}, token=tok_admin)
    check("管理员不能授予站长（403）", st == 403, str(st))
    st, r = req("POST", f"/admin/users/{t_admin_u['id']}/owner", {"on": True}, token=tok_owner)
    check("站长可授予他人站长", st == 200 and r.get("isOwner") is True, str(r))

    # 站长高于超管：超管对站长的一切写操作都要被拦（等级保护）
    aid = t_admin_u["id"]
    st, _ = req("POST", f"/admin/users/{aid}/title", {"title": "越级"}, token=tok_super)
    check("超管不能改站长的头衔（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{aid}/disable", {"on": True}, token=tok_super)
    check("超管不能禁用站长（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{aid}/kick", {}, token=tok_super)
    check("超管不能踢站长下线（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{aid}/password", {"password": "hack-123"}, token=tok_super)
    check("超管不能重置站长密码（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{aid}/admin", {"on": False}, token=tok_super)
    check("超管不能改动站长的管理员位（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{aid}/super", {"on": False}, token=tok_super)
    check("超管不能取消站长的超管位（403）", st == 403, str(st))
    st, _ = req("POST", f"/admin/users/{aid}/owner", {"on": False}, token=tok_super)
    check("超管不能取消站长（403）", st == 403, str(st))

    # 站长反过来能管超管
    st, r = req("POST", f"/admin/users/{suid}/title", {"title": "站长授予"}, token=tok_owner)
    check("站长可改超管的头衔", st == 200 and r.get("title") == "站长授予", str(r))
    req("POST", f"/admin/users/{suid}/title", {"title": ""}, token=tok_owner)

    st, _ = req("POST", f"/admin/users/{oid}/owner", {"on": False}, token=tok_owner)
    check("站长不能取消自己（400）", st == 400, str(st))
    st, r = req("POST", f"/admin/users/{aid}/owner", {"on": False}, token=tok_owner)
    check("站长可取消他人站长（回落超管）", st == 200 and r.get("isOwner") is False, str(r))
    # 取消站长只摘「站长」，该账号仍是超管；这里恢复成普通管理员，避免影响后续与重复运行
    ensure_user("tt_admin", "pass-Tt-1", admin=True)

    st, d = req("GET", "/admin/overview", token=tok_owner)
    check("概览统计站长人数", st == 200 and d.get("owners") == 1,
          str({k: d.get(k) for k in ("owners", "supers", "admins")}))

    # ---------- 清理 ----------
    req("POST", f"/admin/users/{uid}/title", {"title": ""}, token=tok_super)
    req("POST", f"/admin/users/{uid}/super", {"on": False}, token=tok_super)
    req("POST", f"/admin/users/{suid}/title", {"title": ""}, token=tok_owner)
    ensure_user("tt_owner", "pass-Tt-0", owner=True)
    ensure_user("tt_admin", "pass-Tt-1", admin=True)
    ensure_user("tt_super", "pass-Tt-2", super_admin=True)
    ensure_user("tt_user", "pass-Tt-3")
    conn = cm_db.connect()
    conn.execute("DELETE FROM posts WHERE user_id=?", (uid,))
    conn.commit()
    conn.close()

    print(f"\n== 通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("失败项：" + "、".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
