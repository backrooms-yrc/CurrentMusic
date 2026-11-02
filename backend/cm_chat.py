"""公共聊天室（发现页 Chat tab，v1.28.30）。

设计要点（与既有模块的关系）：
  · 实时流复用听歌房的「事件表 + SSE 轮询」模式（见 cm_rooms.emit_event）：
    chat_events 全局单流，SSE 端点先补发积压再持续推送，写 `id: seq` 让
    EventSource 断线自动续传；nginx 侧同样走 /cm/live/ 无缓冲命名空间。
  · 图片沿用 JSON+base64 上传契约（与 cm_ncm_gateway.decode_upload 同形，
    但落本机盘而非转发上游）：魔法字节校验 + 1.5MB 上限（MAX_BODY=2MB，
    base64 膨胀 4/3 后仍在请求体上限内）；前端发送前会压缩到 ≤1280px。
  · @ 提及只存 user_id 列表（JSON），展示层负责高亮——不在存储里冗余昵称，
    用户改昵称后历史消息依然正确关联。
  · 保留最近 500 条（环形清理，与 room_events 同思路），公共聊天不做法务级
    归档；删除为软删（管理员/本人），列表过滤 deleted=1。
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time

import cm_db

CHAT_DIR = os.environ.get("CM_CHAT_DIR", os.path.join(os.path.dirname(cm_db.DB_PATH), "chat"))

MAX_MSG_LEN = 500          # 文本上限（Unicode 字符）
MAX_MENTIONS = 10          # @ 提及人数上限
MAX_ATTS = 5               # 引用内容（单曲/专辑/歌手/歌单）上限
ATT_TYPES = ("song", "album", "artist", "playlist")
MAX_IMAGE_BYTES = int(1.5 * 1024 * 1024)   # 图片解码后上限（请求体走 MAX_BODY=2MB 的 base64）
KEEP_MESSAGES = 500        # 消息环形保留条数
SEND_INTERVAL = 1.5        # 同一用户两次发言最小间隔（秒）
IMAGE_INTERVAL = 5.0       # 同一用户两次传图最小间隔（秒）

# 图片魔法字节（jpg/png/gif/webp）——比 Content-Type 可信（那是客户端自报的）
_IMAGE_MAGIC = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def sniff_image_ext(head: bytes):
    """按魔法字节认图片类型；webp 看 RIFF 头 + 第 8-12 字节的 WEBP 标识。"""
    for magic, ext in _IMAGE_MAGIC:
        if head.startswith(magic):
            return ext
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return ""


def validate_content(text):
    """清洗文本：去首尾空白与控制字符（保留换行），截到上限。返回 (ok, text)。"""
    if text is None:
        text = ""
    if not isinstance(text, str):
        return False, ""
    out = "".join(ch for ch in text if ch == "\n" or ord(ch) >= 32)
    out = re.sub(r"\n{3,}", "\n\n", out.strip())
    if len(out) > MAX_MSG_LEN:
        out = out[:MAX_MSG_LEN]
    return True, out


def parse_atts(raw):
    """引用内容：最多 5 项，只认 white-list 字段，非法项静默丢弃。"""
    if not isinstance(raw, list):
        return []
    out = []
    for v in raw[: MAX_ATTS * 2]:
        if not isinstance(v, dict):
            continue
        t = str(v.get("type") or "")
        if t not in ATT_TYPES:
            continue
        try:
            i = int(v.get("id"))
        except (TypeError, ValueError):
            continue
        name = str(v.get("name") or "").strip()[:120]
        if i <= 0 or not name:
            continue
        pic = str(v.get("pic") or "").strip()[:400]
        if pic and not (pic.startswith("http://") or pic.startswith("https://")):
            pic = ""                            # 只接受 http(s) 图片，杜绝 javascript: 等
        out.append({"type": t, "id": i, "name": name,
                    "sub": str(v.get("sub") or "").strip()[:120], "pic": pic})
        if len(out) >= MAX_ATTS:
            break
    return out


def parse_mentions(raw):
    """@ 提及 id 列表：只收正整数、去重、截上限。非法输入整项丢弃而非报错。"""
    if not isinstance(raw, list):
        return []
    out = []
    for v in raw[: MAX_MENTIONS * 2]:
        try:
            i = int(v)
        except (TypeError, ValueError):
            continue
        if i > 0 and i not in out:
            out.append(i)
        if len(out) >= MAX_MENTIONS:
            break
    return out


def init_chat_tables(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT DEFAULT '',
      image TEXT DEFAULT '',
      mentions TEXT DEFAULT '',
      atts TEXT DEFAULT '',
      deleted INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    """)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(chat_messages)")}
    if "atts" not in cols:                     # 旧库补列：引用内容（单曲/专辑/歌手/歌单）
        conn.execute("ALTER TABLE chat_messages ADD COLUMN atts TEXT DEFAULT ''")
    os.makedirs(CHAT_DIR, exist_ok=True)


# ---------------------------------------------------------------- 发言频控（进程内）

_last_act: dict = {}       # (uid, kind) -> ts


def _throttled(uid, kind, interval):
    key = (int(uid), kind)
    now = time.time()
    if now - _last_act.get(key, 0) < interval:
        return True
    _last_act[key] = now
    # 顺手清理久远的键，防内存缓慢增长
    if len(_last_act) > 4096:
        for k in [k for k, t in _last_act.items() if now - t > 3600]:
            _last_act.pop(k, None)
    return False


# ---------------------------------------------------------------- 消息

_USER_FIELDS = "u.id, u.username, u.nickname, u.avatar, u.title, u.avatar_decoration, u.is_admin, u.is_super, u.is_owner, u.is_bot"


def _user_out(u):
    u = dict(u)          # sqlite3.Row 没有 .get()，统一转 dict
    return {"id": u["id"], "username": u["username"], "nickname": u["nickname"],
            "avatar": u["avatar"] or "", "avatarDecoration": u["avatar_decoration"] or "",
            "title": u["title"] or "",
            "isAdmin": bool(u["is_admin"]), "isSuper": bool(u["is_super"]),
            "isOwner": bool(u["is_owner"]), "isBot": bool(u.get("is_bot"))}


def _row_out(msg, user, mention_users, streaming=False):
    """msg=消息行，user=发送者 users 行（可 None，已删用户），mention_users=被 @ 者列表。"""
    try:
        atts = json.loads(msg.get("atts") or "[]")
    except ValueError:
        atts = []
    return {"id": msg["id"], "userId": msg["user_id"], "content": msg["content"] or "",
            "image": msg["image"] or "", "atts": atts, "createdAt": msg["created_at"],
            "user": _user_out(user) if user else None,
            "mentions": [_user_out(m) for m in mention_users],
            "streaming": bool(streaming)}


def _with_users(rows):
    """批量补发送者与提及者信息（各查一次，聊天单页 ≤50 条，量级无压力）。"""
    conn = cm_db.connect()
    try:
        all_ids = set()
        for r in rows:
            all_ids.add(r["user_id"])
            all_ids.update(json.loads(r["mentions"] or "[]"))
        users = {}
        if all_ids:
            ph = ",".join("?" * len(all_ids))
            for u in conn.execute(f"SELECT {_USER_FIELDS} FROM users u WHERE u.id IN ({ph})",
                                  tuple(all_ids)):
                users[u["id"]] = dict(u)
        out = []
        for r in rows:
            mids = json.loads(r["mentions"] or "[]")
            out.append(_row_out(r, users.get(r["user_id"]),
                                [users[i] for i in mids if i in users]))
        return out
    finally:
        conn.close()


def send(user, content, image, mentions, atts=None, streaming=False):
    """落库一条消息并广播。调用方负责鉴权、频控与文本清洗。"""
    conn = cm_db.connect()
    try:
        cur = conn.execute(
            "INSERT INTO chat_messages(user_id, content, image, mentions, atts, created_at) VALUES(?,?,?,?,?,?)",
            (user["id"], content, image or "", json.dumps(mentions or []),
             json.dumps(atts or [], ensure_ascii=False), int(time.time())))
        mid = cur.lastrowid
        # 环形清理：只留最近 KEEP_MESSAGES 条
        old = conn.execute(
            "SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET ?",
            (KEEP_MESSAGES,)).fetchone()
        if old:
            conn.execute("DELETE FROM chat_messages WHERE id<=?", (old["id"],))
        # 提及者信息一并带出（SSE 收端无需再查库）
        ph = ",".join("?" * len(mentions)) if mentions else ""
        mrows = conn.execute(
            f"SELECT {_USER_FIELDS} FROM users u WHERE u.id IN ({ph})",
            tuple(mentions)) if mentions else []
        mops = [dict(m) for m in mrows]     # Row 绑定连接，必须在 close 前转 dict
        conn.commit()
    finally:
        conn.close()
    out = _row_out({"id": mid, "user_id": user["id"], "content": content,
                    "image": image or "", "atts": json.dumps(atts or [], ensure_ascii=False),
                    "created_at": int(time.time())},
                   {k: user.get(k) for k in
                    ("id", "username", "nickname", "avatar", "avatar_decoration",
                     "title", "is_admin", "is_super", "is_owner", "is_bot")},
                   mops, streaming)
    emit("message", out)
    return out


def edit(mid, content, atts=None, streaming=False):
    """更新一条已存在的消息（AI 流式输出用）：落库并广播 edit 事件。"""
    atts = atts or []
    conn = cm_db.connect()
    try:
        conn.execute(
            "UPDATE chat_messages SET content=?, atts=? WHERE id=? AND deleted=0",
            (content or "", json.dumps(atts, ensure_ascii=False), int(mid)))
        conn.commit()
    finally:
        conn.close()
    payload = {"id": int(mid), "content": content or "", "atts": atts,
               "streaming": bool(streaming), "updatedAt": int(time.time())}
    emit("edit", payload)
    return payload


def list_messages(before=0, limit=30):
    """最近消息（时间升序返回）。before=<id> 向更早翻页。"""
    limit = max(1, min(50, int(limit or 30)))
    conn = cm_db.connect()
    try:
        if before:
            rows = conn.execute(
                "SELECT * FROM chat_messages WHERE deleted=0 AND id<? ORDER BY id DESC LIMIT ?",
                (int(before), limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM chat_messages WHERE deleted=0 ORDER BY id DESC LIMIT ?",
                (limit,)).fetchall()
        return _with_users(list(reversed([dict(r) for r in rows])))
    finally:
        conn.close()


def delete_message(mid, user):
    """软删：本人或管理员（is_admin/is_super/is_owner）。返回是否删除。"""
    conn = cm_db.connect()
    try:
        r = conn.execute("SELECT * FROM chat_messages WHERE id=? AND deleted=0", (int(mid),)).fetchone()
        if not r:
            return False
        if r["user_id"] != user["id"] and not (user.get("is_admin") or user.get("is_super")
                                               or user.get("is_owner")):
            return False
        conn.execute("UPDATE chat_messages SET deleted=1 WHERE id=?", (int(mid),))
        conn.commit()
    finally:
        conn.close()
    emit("delete", {"id": int(mid)})
    return True


def like_pattern(query, prefix_only=False):
    """把用户输入转成安全的 LIKE 模式（转义 \\ % _），可选前缀匹配。"""
    q = str(query or "")
    q = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{q}%" if prefix_only else f"%{q}%"


def search_members(query, limit=8):
    """@ 提及实时搜索：昵称/用户名模糊匹配（前缀命中优先，其次新注册）。

    只搜「公开到广场」的启用用户（尊重 public_square=0），与 recent_members 同一口径。
    """
    limit = max(1, min(20, int(limit or 8)))
    q = str(query or "").strip()
    if not q:
        return recent_members(limit)
    conn = cm_db.connect()
    try:
        rows = conn.execute(
            f"""SELECT {_USER_FIELDS} FROM users u
                WHERE u.disabled=0 AND (u.public_square=1 OR u.is_bot=1) AND u.username!='__internal__'
                  AND (u.nickname LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
                ORDER BY CASE WHEN u.nickname LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                         u.id DESC
                LIMIT ?""",
            (like_pattern(q), like_pattern(q), like_pattern(q, prefix_only=True), limit),
        ).fetchall()
        return [_user_out(r) for r in rows]
    finally:
        conn.close()


def recent_members(limit=20):
    """近 7 天活跃聊天成员（@ 选择器用）。尊重 public_square=0 的用户（不出现在选择器里）。"""
    limit = max(1, min(50, int(limit or 20)))
    conn = cm_db.connect()
    try:
        rows = conn.execute(
            f"""SELECT {_USER_FIELDS}, MAX(m.created_at) AS last_at
                FROM chat_messages m JOIN users u ON u.id=m.user_id
                WHERE m.created_at>? AND u.disabled=0 AND u.public_square=1
                GROUP BY m.user_id ORDER BY last_at DESC LIMIT ?""",
            (int(time.time()) - 7 * 86400, limit)).fetchall()
        out = [_user_out(r) for r in rows]
        if len(out) < limit:                 # 活跃人少时用广场注册最新补齐，选择器不至于空
            have = tuple(u["id"] for u in out)
            not_in = ",".join("?" * len(have)) if have else "0"
            rows2 = conn.execute(
                f"""SELECT {_USER_FIELDS} FROM users u
                    WHERE u.disabled=0 AND (u.public_square=1 OR u.is_bot=1) AND u.id NOT IN ({not_in})
                    ORDER BY u.created_at DESC LIMIT ?""",
                have + (limit - len(out),))
            out.extend(_user_out(r) for r in rows2)
        return out
    finally:
        conn.close()


# ---------------------------------------------------------------- 事件（SSE 源）

MAX_EVENTS = 200


def emit(etype, payload):
    conn = cm_db.connect()
    try:
        conn.execute("INSERT INTO chat_events(type, payload, created_at) VALUES(?,?,?)",
                     (etype, json.dumps(payload, ensure_ascii=False), int(time.time())))
        old = conn.execute(
            "SELECT seq FROM chat_events ORDER BY seq DESC LIMIT 1 OFFSET ?", (MAX_EVENTS,)
        ).fetchone()
        if old:
            conn.execute("DELETE FROM chat_events WHERE seq<=?", (old["seq"],))
        conn.commit()
    finally:
        conn.close()


def latest_seq():
    conn = cm_db.connect()
    try:
        return conn.execute("SELECT COALESCE(MAX(seq),0) FROM chat_events").fetchone()[0]
    finally:
        conn.close()


def events_since(since_seq, limit=50):
    conn = cm_db.connect()
    try:
        rows = conn.execute(
            "SELECT * FROM chat_events WHERE seq>? ORDER BY seq LIMIT ?", (int(since_seq), limit)
        ).fetchall()
        out = []
        for r in rows:
            try:
                out.append({"seq": r["seq"], "type": r["type"],
                            "payload": json.loads(r["payload"]), "createdAt": r["created_at"]})
            except ValueError:
                continue
        return out
    finally:
        conn.close()


# ---------------------------------------------------------------- 图片

_FILE_RE = re.compile(r"^[a-f0-9]{16}\.(jpg|png|gif|webp)$")


def save_image(data: bytes):
    """校验魔法字节与体积，落盘 data/chat/<token>.<ext>。返回文件名。"""
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片为空或超过 1.5MB 上限")
    ext = sniff_image_ext(data[:16])
    if not ext:
        raise ValueError("仅支持 jpg/png/gif/webp")
    os.makedirs(CHAT_DIR, exist_ok=True)
    name = f"{secrets.token_hex(8)}.{ext}"
    with open(os.path.join(CHAT_DIR, name), "wb") as f:
        f.write(data)
    return name


def image_path(name):
    """取图片绝对路径；文件名不合规一律拒绝（防路径穿越）。"""
    if not _FILE_RE.match(str(name or "")):
        return ""
    fp = os.path.join(CHAT_DIR, name)
    return fp if os.path.isfile(fp) else ""


def throttled_send(uid):
    return _throttled(uid, "send", SEND_INTERVAL)


def throttled_image(uid):
    return _throttled(uid, "image", IMAGE_INTERVAL)
