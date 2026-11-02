#!/usr/bin/env python3
"""弹窗公告端到端冒烟测试（v1.28.22）。

用**临时库**起一个实例再跑，避免污染线上数据：

    CM_DB=/tmp/ann.db CM_PORT=3098 python3 backend/cm_server.py &
    CM_DB=/tmp/ann.db python3 tools/announcement-smoke.py http://127.0.0.1:3098

覆盖：公开读取、管理员发布、普通管理员只能改自己的（403）、超管可改全部、
置顶切换与排序、软删后公开列表不再下发而管理列表仍可见、字段校验、非管理员被拒。
退出码 0 = 全部通过。
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3010").rstrip("/")
API = BASE + "/cm"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import cm_db  # noqa: E402

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


PHONES = {"ann_admin": "13800007001", "ann_admin2": "13800007002",
          "ann_super": "13800007003", "ann_user": "13800007004"}


def ensure_user(username, password, admin=False, super_admin=False):
    u = cm_db.get_user_by_name(username)
    if not u:
        uid = cm_db.create_user(username, password, username + "（公告测试）",
                                email=username + "@example.com", phone=PHONES.get(username, ""))
        u = cm_db.get_user(uid)
    if admin or super_admin:
        conn = cm_db.connect()
        conn.execute("UPDATE users SET is_admin=1, is_super=? WHERE id=?", (1 if super_admin else 0, u["id"]))
        conn.commit()
        conn.close()
        u = cm_db.get_user(u["id"])
    return u


def login(username, password):
    _, r = req("POST", "/auth/login", {"username": username, "password": password})
    return r.get("token", "")


def reset_announcements():
    conn = cm_db.connect()
    conn.execute("DELETE FROM announcements")
    conn.commit()
    conn.close()


def main():
    detect_api()
    print(f"== 弹窗公告冒烟测试 @ {API}\n")
    ensure_user("ann_admin", "pass-Ann-1", admin=True)
    ensure_user("ann_admin2", "pass-Ann-2", admin=True)
    ensure_user("ann_super", "pass-Ann-3", super_admin=True)
    ensure_user("ann_user", "pass-Ann-4")
    reset_announcements()
    t_admin = login("ann_admin", "pass-Ann-1")
    t_admin2 = login("ann_admin2", "pass-Ann-2")
    t_super = login("ann_super", "pass-Ann-3")
    t_user = login("ann_user", "pass-Ann-4")
    check("测试账号登录（2 管理员 + 超管 + 普通用户）", all([t_admin, t_admin2, t_super, t_user]))

    st, d = req("GET", "/announcements")
    check("公开读取公告（未登录，空列表）", st == 200 and d.get("items") == [], str(d)[:120])

    st, _ = req("POST", "/announcements", {"title": "越权", "body": "x"}, token=t_user)
    check("普通用户不能发布公告（403）", st == 403)
    st, _ = req("POST", "/announcements", {"title": "越权"}, token=None)
    check("未登录不能发布公告（401）", st == 401)

    st, r1 = req("POST", "/announcements",
                 {"title": "服务维护通知", "body": "今晚 23:00 起维护，预计 30 分钟。", "pinned": True},
                 token=t_admin)
    aid1 = r1.get("id")
    st, r2 = req("POST", "/announcements",
                 {"title": "新版本 v1.28.22", "body": "新增弹窗公告。", "link": "https://music.20110208.xyz"},
                 token=t_admin2)
    aid2 = r2.get("id")
    check("管理员可发布公告", st == 200 and aid1 and aid2, f"{st} {r1} {r2}")

    st, _ = req("POST", "/announcements", {"title": "x", "body": "y", "link": "javascript:alert(1)"}, token=t_admin)
    check("拒绝非 http(s) 链接（400）", st == 400)
    st, _ = req("POST", "/announcements", {"body": "没有标题"}, token=t_admin)
    check("标题必填（400）", st == 400)

    st, d = req("GET", "/announcements")
    items = d.get("items") or []
    order = [a["title"] for a in items]
    check("公开列表返回两条且置顶在前",
          st == 200 and len(items) == 2 and order[0] == "服务维护通知", str(order))
    check("公开列表带作者与时间", all("author" in a and a.get("createdAt") for a in items))
    check("公开列表不下发 removed 字段（客户端无需关心）",
          all("removed" not in a for a in items))

    st, _ = req("PUT", f"/announcements/{aid2}", {"title": "别人改的", "body": "x"}, token=t_admin)
    check("管理员不能改他人公告（403）", st == 403)
    st, _ = req("DELETE", f"/announcements/{aid2}", token=t_admin)
    check("管理员不能删他人公告（403）", st == 403)
    st, _ = req("PUT", f"/announcements/{aid2}",
                {"title": "新版本 v1.28.22（超管修订）", "body": "新增弹窗公告，支持置顶。",
                 "link": "https://music.20110208.xyz"}, token=t_super)
    check("超管可改任意公告", st == 200, str(_)[:120])
    st, d = req("GET", "/announcements")
    check("编辑已生效", any("超管修订" in a["title"] for a in (d.get("items") or [])))

    st, r = req("POST", f"/announcements/{aid2}/pin", {}, token=t_super)
    check("超管可置顶他人公告", st == 200 and r.get("pinned") is True, str(r))
    st, d = req("GET", "/announcements")
    check("置顶后排序更新", (d.get("items") or [{}])[0]["title"].startswith("新版本"), str([a["title"] for a in d.get("items") or []]))
    st, r = req("POST", f"/announcements/{aid2}/pin", {}, token=t_super)
    check("再次点击取消置顶", r.get("pinned") is False)
    st, _ = req("POST", f"/announcements/{aid2}/pin", {}, token=t_admin)
    check("管理员不能置顶他人公告（403）", st == 403)

    st, _ = req("DELETE", f"/announcements/{aid1}", token=t_admin)
    check("删除自己的公告", st == 200)
    st, d = req("GET", "/announcements")
    check("移除后公开列表不再下发", all(a["id"] != aid1 for a in d.get("items") or []))
    st, d = req("GET", "/admin/announcements", token=t_admin)
    items = d.get("items") or []
    mine = [a for a in items if a["id"] == aid1]
    check("管理列表仍能看到已移除（软删保留审计）", st == 200 and mine and mine[0]["removed"] is True, str(items)[:160])
    check("管理列表返回 canEdit 权限标记",
          all("canEdit" in a for a in items) and [a["canEdit"] for a in items if a["id"] == aid2][0] is False)
    st, d = req("GET", "/admin/announcements", token=t_super)
    check("超管列表 isSuper=true 且对全部可编辑",
          d.get("isSuper") is True and all(a["canEdit"] for a in d.get("items") or []))
    st, _ = req("GET", "/admin/announcements", token=t_user)
    check("普通用户读管理列表被拒（403）", st == 403)

    st, _ = req("POST", f"/announcements/{aid1}/restore", {}, token=t_admin)
    st2, d = req("GET", "/announcements")
    check("可恢复已移除的公告", st == 200 and any(a["id"] == aid1 for a in d.get("items") or []))
    st, _ = req("POST", f"/announcements/{aid2}/restore", {}, token=t_admin)
    check("管理员不能恢复他人公告（403）", st == 403)

    st, _ = req("PUT", "/announcements/999999", {"title": "x", "body": "y"}, token=t_super)
    check("编辑不存在的公告（404）", st == 404)

    print(f"\n== 通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("失败项：" + "、".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
