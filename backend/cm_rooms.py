"""听歌房生命周期、成员、队列、权威时间轴和持久事件。"""
from contextlib import contextmanager
import json
import secrets
import time

from cm_db import connect, hash_password

ONLINE_SECONDS = 60
IDLE_SECONDS = 30 * 60
SWEEP_SECONDS = 30
MAX_EVENTS_PER_ROOM = 200
MAX_QUEUED = 200
PREBUFFER_MS = 1200
CONTROLLERS = ("owner", "admin")
SETTINGS = {
    "isPublic": "is_public", "freeMode": "free_mode",
    "needApproval": "need_approval", "joinLocked": "join_locked",
}


class RoomError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def now_ms():
    return time.time_ns() // 1_000_000


@contextmanager
def transaction(write=False):
    conn = connect()
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield conn
    finally:
        conn.close()


def init_room_tables(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      salt TEXT DEFAULT '',
      password_hash TEXT DEFAULT '',
      is_public INTEGER DEFAULT 1,
      free_mode INTEGER DEFAULT 0,
      need_approval INTEGER DEFAULT 1,
      join_locked INTEGER DEFAULT 0,
      max_members INTEGER DEFAULT 200,
      closed_at INTEGER DEFAULT 0,
      track_ncm_id INTEGER DEFAULT 0,
      track_meta TEXT DEFAULT '',
      stream_level TEXT DEFAULT '',
      stream_url TEXT DEFAULT '',
      stream_expire_at INTEGER DEFAULT 0,
      base_position INTEGER DEFAULT 0,
      base_at INTEGER DEFAULT 0,
      playing INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_public ON rooms(is_public, closed_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id, closed_at);
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      nickname TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      muted INTEGER DEFAULT 0,
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rm_user ON room_members(user_id, last_seen DESC);
    CREATE TABLE IF NOT EXISTS room_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      ncm_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      artists TEXT DEFAULT '',
      pic TEXT DEFAULT '',
      duration INTEGER DEFAULT 0,
      requested_by INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      seq INTEGER NOT NULL DEFAULT 0,
      reviewed_by INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rq ON room_queue(room_id, status, seq);
    CREATE TABLE IF NOT EXISTS room_events (
      room_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, seq)
    );
    CREATE TABLE IF NOT EXISTS room_bans (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      banned_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    """)
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(rooms)")}
        if "archive_reason" not in columns:
            conn.execute("ALTER TABLE rooms ADD COLUMN archive_reason TEXT NOT NULL DEFAULT ''")
            conn.execute("ALTER TABLE rooms ADD COLUMN track_revision INTEGER NOT NULL DEFAULT 0")
            conn.execute("ALTER TABLE room_queue ADD COLUMN play_order INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE rooms SET archive_reason='manual', playing=0 WHERE closed_at!=0")
            conn.execute("UPDATE room_queue SET play_order=id WHERE status IN ('playing','played')")
            conn.execute("""UPDATE room_members SET role=CASE
                WHEN user_id=(SELECT owner_id FROM rooms WHERE id=room_id) THEN 'owner'
                ELSE 'admin' END WHERE role='owner' OR
                user_id=(SELECT owner_id FROM rooms WHERE id=room_id)""")
            # 旧版 settings 事件可能存过明文密码。保留游标并清空载荷。
            conn.execute("UPDATE room_events SET payload='{}' WHERE type='settings'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rooms_idle ON rooms(closed_at,updated_at)")


def integer(value, label, minimum=0, maximum=2**63 - 1):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise RoomError(400, f"{label}格式错误")
    try:
        number = int(value)
    except ValueError:
        raise RoomError(400, f"{label}格式错误") from None
    if not minimum <= number <= maximum:
        raise RoomError(400, f"{label}超出范围")
    return number


def password_fields(password):
    if not isinstance(password, str) or len(password) > 128:
        raise RoomError(400, "房间密码最多 128 个字符")
    salt = secrets.token_hex(8) if password else ""
    return salt, hash_password(password, salt) if password else ""


def settings_fields(fields):
    changes = {}
    for key, column in SETTINGS.items():
        alias = key if key in fields else column
        if alias in fields:
            value = fields[alias]
            if not isinstance(value, bool) and not (type(value) is int and value in (0, 1)):
                raise RoomError(400, f"{key}应为布尔值")
            changes[column] = int(value)
    if "name" in fields:
        name = fields["name"]
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise RoomError(400, "房间名须为 1 至 60 个字符")
        changes["name"] = name.strip()
    if "password" in fields:
        changes["salt"], changes["password_hash"] = password_fields(fields["password"])
    return changes


def room_by_ident(conn, ident, *, by_code=False):
    row = None
    if not by_code and ident.isascii() and ident.isdigit() and len(ident) <= 19:
        number = int(ident)
        if number <= 2**63 - 1:
            row = conn.execute("SELECT * FROM rooms WHERE id=?", (number,)).fetchone()
    if row is None and len(ident) == 6 and ident.isascii() and ident.isdigit():
        row = conn.execute("SELECT * FROM rooms WHERE code=?", (ident,)).fetchone()
    return dict(row) if row else None


def get_member(conn, room_id, user_id):
    row = conn.execute("SELECT * FROM room_members WHERE room_id=? AND user_id=?",
                       (room_id, user_id)).fetchone()
    return dict(row) if row else None


def require_room(conn, ident, user_id, *, permission=None, archived=False, by_code=False):
    room = room_by_ident(conn, ident, by_code=by_code)
    if not room:
        raise RoomError(404, "房间不存在或已删除")
    owner = room["owner_id"] == user_id
    if room["closed_at"] and (not archived or not owner):
        raise RoomError(404, "房间已归档")
    member = get_member(conn, room["id"], user_id)
    if permission == "owner" and not owner:
        raise RoomError(403, "需要房主权限")
    if permission == "admin" and (not member or member["role"] not in CONTROLLERS):
        raise RoomError(403, "需要房主或管理员权限")
    if permission == "member" and not member:
        raise RoomError(403, "请先加入房间")
    return room, member


def update_room(conn, room_id, fields):
    assignments = ", ".join(f"{name}=?" for name in fields)
    conn.execute(f"UPDATE rooms SET {assignments} WHERE id=?", (*fields.values(), room_id))


def create_room(conn, user, changes):
    now = int(time.time())
    for _ in range(20):
        code = f"{secrets.randbelow(1_000_000):06d}"
        cur = conn.execute("""INSERT INTO rooms(code,name,owner_id,created_at,updated_at)
            VALUES(?,?,?,?,?) ON CONFLICT(code) DO NOTHING""",
                           (code, changes["name"], user["id"], now, now))
        if cur.rowcount:
            break
    else:
        raise RoomError(503, "暂时无法分配房间号")
    room_id = cur.lastrowid
    update_room(conn, room_id, changes)
    join_room(conn, room_by_ident(conn, str(room_id)), user)
    return room_by_ident(conn, str(room_id))


def list_rooms(conn, user_id, scope, query, limit, offset):
    now = int(time.time())
    where, args = ("r.owner_id=?", [user_id]) if scope == "mine" else (
        "r.closed_at=0 AND r.is_public=1", [])
    if query:
        where += " AND (instr(r.name,?)>0 OR instr(r.code,?)>0)"
        args.extend((query, query))
    rows = conn.execute(
        f"""SELECT r.id, r.code, r.name, r.owner_id, r.free_mode, r.need_approval,
                   r.track_meta, r.playing, r.base_position, r.base_at, r.max_members,
                   r.join_locked, (r.password_hash!='') AS has_password, r.closed_at, r.archive_reason,
                   CASE WHEN r.closed_at=0 THEN
                       (SELECT COUNT(*) FROM room_members m WHERE m.room_id=r.id AND m.last_seen >= ?)
                       ELSE 0 END AS online,
                   u.nickname AS owner_name
            FROM rooms r LEFT JOIN users u ON u.id=r.owner_id
            WHERE {where} ORDER BY (r.closed_at!=0), online DESC, r.updated_at DESC, r.id DESC
            LIMIT ? OFFSET ?""",
        (now - ONLINE_SECONDS, *args, limit, offset),
    ).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM rooms r WHERE {where}", args).fetchone()[0]
    return {"total": total, "rooms": [
        dict(row, track_meta=json.loads(row["track_meta"] or "null")) for row in rows
    ]}


def archive_room(conn, room, reason, actor=0):
    now = int(time.time())
    room_id = room["id"]
    update_room(conn, room_id, {
        "closed_at": now, "archive_reason": reason, "updated_at": now, "playing": 0,
        "base_position": position(room), "base_at": now_ms(),
        "stream_url": "", "stream_expire_at": 0,
    })
    emit_event(conn, room_id, "close", {"reason": reason, "by": actor})


def archive_idle_rooms():
    cutoff = int(time.time()) - IDLE_SECONDS
    with transaction(write=True) as conn:
        rooms = conn.execute("""SELECT * FROM rooms r WHERE closed_at=0 AND updated_at<=?
            AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=r.id AND last_seen>?)""",
                             (cutoff, cutoff)).fetchall()
        for row in rooms:
            archive_room(conn, dict(row), "idle")
        return len(rooms)


def reopen_room(conn, room, user):
    if not room["closed_at"]:
        join_room(conn, room, user)
        return
    room_id = room["id"]
    # 新一轮活动由房主开始，旧成员要重新加入，封禁记录仍有效。
    conn.execute("DELETE FROM room_members WHERE room_id=?", (room_id,))
    update_room(conn, room_id, {"closed_at": 0, "archive_reason": "",
                               "track_revision": room["track_revision"] + 1,
                               "updated_at": int(time.time())})
    join_room(conn, room_by_ident(conn, str(room_id)), user)
    emit_event(conn, room_id, "reopen", {"by": user["id"]})


def delete_room(conn, room_id):
    for table in ("room_members", "room_queue", "room_events", "room_bans", "rooms"):
        conn.execute(f"DELETE FROM {table} WHERE {'id' if table == 'rooms' else 'room_id'}=?", (room_id,))


def count_online(conn, room_id, now):
    return conn.execute("SELECT COUNT(*) FROM room_members WHERE room_id=? AND last_seen>=?",
                        (room_id, now - ONLINE_SECONDS)).fetchone()[0]


def check_capacity(conn, room, member, now):
    if not member or member["last_seen"] < now - ONLINE_SECONDS:
        if count_online(conn, room["id"], now) >= room["max_members"]:
            raise RoomError(409, "房间已满")


def verify_password(room, password):
    return secrets.compare_digest(hash_password(password, room["salt"]), room["password_hash"])


def join_room(conn, room, user, *, password_checked=False):
    now = int(time.time())
    uid, room_id = user["id"], room["id"]
    member = get_member(conn, room_id, uid)
    owner = uid == room["owner_id"]
    if not owner:
        if conn.execute("SELECT 1 FROM room_bans WHERE room_id=? AND user_id=?", (room_id, uid)).fetchone():
            raise RoomError(403, "你已被该房间封禁")
        if not member:
            if room["join_locked"]:
                raise RoomError(403, "房间已锁定，暂不接受加入")
            if room["password_hash"] and not password_checked:
                raise RoomError(403, "房间密码错误")
    check_capacity(conn, room, member, now)
    role = "owner" if owner else member["role"] if member else "member"
    conn.execute("""INSERT INTO room_members(room_id,user_id,role,nickname,avatar,joined_at,last_seen)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET
        role=excluded.role,nickname=excluded.nickname,avatar=excluded.avatar,last_seen=excluded.last_seen""",
                 (room_id, uid, role, user["nickname"], user.get("avatar") or "", now, now))
    if not member or member["last_seen"] < now - ONLINE_SECONDS:
        emit_event(conn, room_id, "join", {"userId": uid})
    return role


def heartbeat(conn, room, member):
    now = int(time.time())
    if member["last_seen"] >= now - 10:
        return
    check_capacity(conn, room, member, now)
    conn.execute("UPDATE room_members SET last_seen=? WHERE room_id=? AND user_id=?",
                 (now, room["id"], member["user_id"]))
    if member["last_seen"] < now - ONLINE_SECONDS:
        emit_event(conn, room["id"], "join", {"userId": member["user_id"]})


def leave_room(conn, room, uid):
    room_id = room["id"]
    if conn.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?", (room_id, uid)).rowcount:
        update_room(conn, room_id, {"updated_at": int(time.time())})
        emit_event(conn, room_id, "leave", {"userId": uid})


def list_members(conn, room_id):
    return [dict(row) for row in conn.execute("""
        SELECT rm.*, u.title, u.is_admin, u.is_super, u.is_owner
        FROM room_members rm LEFT JOIN users u ON u.id=rm.user_id
        WHERE rm.room_id=? AND rm.last_seen>=?
        ORDER BY CASE rm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, rm.joined_at, rm.user_id
        """, (room_id, int(time.time()) - ONLINE_SECONDS))]


def manage_member(conn, room, actor, target_id, action, *, on=True, ban=False, reason=""):
    room_id = room["id"]
    if target_id in (room["owner_id"], actor["user_id"]):
        raise RoomError(400, "不能对房主或自己执行此操作")
    target = get_member(conn, room_id, target_id)
    if not target:
        raise RoomError(404, "目标不是房间成员")
    if action == "kick":
        if actor["role"] != "owner" and target["role"] == "admin":
            raise RoomError(403, "只有房主可以移出管理员")
        conn.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?", (room_id, target_id))
        if ban:
            conn.execute("""INSERT OR REPLACE INTO room_bans(room_id,user_id,reason,banned_by,created_at)
                VALUES(?,?,?,?,?)""", (room_id, target_id, reason, actor["user_id"], int(time.time())))
        emit_event(conn, room_id, "kick", {"userId": target_id, "by": actor["user_id"]})
    elif action == "transfer":
        conn.execute("UPDATE room_members SET role='admin' WHERE room_id=? AND user_id=?",
                     (room_id, actor["user_id"]))
        conn.execute("UPDATE room_members SET role='owner' WHERE room_id=? AND user_id=?",
                     (room_id, target_id))
        update_room(conn, room_id, {"owner_id": target_id, "updated_at": int(time.time())})
        emit_event(conn, room_id, "transfer", {"from": actor["user_id"], "to": target_id})
    else:
        role = "admin" if on else "member"
        conn.execute("UPDATE room_members SET role=? WHERE room_id=? AND user_id=?",
                     (role, room_id, target_id))
        emit_event(conn, room_id, "role", {"userId": target_id, "role": role})


def list_bans(conn, room_id):
    return [dict(row) for row in conn.execute("""SELECT b.user_id AS userId, b.reason, u.nickname,
        b.created_at AS createdAt FROM room_bans b LEFT JOIN users u ON u.id=b.user_id
        WHERE room_id=? ORDER BY b.created_at DESC""", (room_id,))]


def queue_list(conn, room_id, uid, role):
    return [dict(row) for row in conn.execute("""
        SELECT q.*, u.nickname AS requester FROM room_queue q LEFT JOIN users u ON u.id=q.requested_by
        WHERE q.room_id=? AND (q.status IN ('queued','playing','played')
            OR (q.status='pending' AND (? OR q.requested_by=?)))
        ORDER BY CASE q.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
            CASE WHEN q.status='played' THEN -q.play_order ELSE q.seq END, q.id
        """, (room_id, role in CONTROLLERS, uid))]


def song_meta(meta):
    if not isinstance(meta, dict):
        raise RoomError(400, "歌曲信息必须为对象")
    name = meta.get("name")
    if not isinstance(name, str) or not name.strip():
        raise RoomError(400, "缺少歌曲名")
    pic = str(meta.get("pic") or "")[:500]
    return {
        "ncm_id": integer(meta.get("ncm_id", meta.get("ncmId")), "歌曲 ID", minimum=1),
        "name": name.strip()[:200], "artists": str(meta.get("artists") or "")[:300],
        "pic": pic if pic.startswith(("https://", "http://")) else "",
        "duration": integer(meta.get("duration") or 0, "歌曲时长"),
    }


def next_seq(conn, room_id):
    return conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM room_queue WHERE room_id=? AND status='queued'",
                        (room_id,)).fetchone()[0]


def queue_add(conn, room, member, meta):
    room_id = room["id"]
    if member["muted"]:
        raise RoomError(403, "你已被限制点歌")
    count = conn.execute("SELECT COUNT(*) FROM room_queue WHERE room_id=? AND status IN ('pending','queued')",
                         (room_id,)).fetchone()[0]
    if count >= MAX_QUEUED:
        raise RoomError(409, "点歌队列已满")
    auto = bool(room["free_mode"] or not room["need_approval"] or member["role"] in CONTROLLERS)
    status, seq = ("queued", next_seq(conn, room_id)) if auto else ("pending", 0)
    cur = conn.execute("""INSERT INTO room_queue(room_id,ncm_id,name,artists,pic,duration,
        requested_by,status,seq,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                       (room_id, *meta.values(), member["user_id"], status, seq, int(time.time())))
    emit_event(conn, room_id, "queue", {"action": "add"})
    return dict(meta, id=cur.lastrowid, status=status, seq=seq, requested_by=member["user_id"],
                requester=member["nickname"]), auto


def queue_change(conn, room_id, member, qid, action):
    item = conn.execute("SELECT * FROM room_queue WHERE id=? AND room_id=?", (qid, room_id)).fetchone()
    if not item or item["status"] == "rejected":
        raise RoomError(404, "队列条目不存在")
    if action == "remove":
        if item["requested_by"] != member["user_id"] and member["role"] not in CONTROLLERS:
            raise RoomError(403, "只能撤回自己点的歌")
        if item["status"] == "playing":
            raise RoomError(409, "请先切换正在播放的歌曲")
        conn.execute("DELETE FROM room_queue WHERE id=?", (qid,))
    else:
        if item["status"] != "pending":
            raise RoomError(409, "这首歌已处理")
        status, seq = ("queued", next_seq(conn, room_id)) if action == "approve" else ("rejected", 0)
        conn.execute("UPDATE room_queue SET status=?,seq=?,reviewed_by=?,reviewed_at=? WHERE id=?",
                     (status, seq, member["user_id"], int(time.time()), qid))
    emit_event(conn, room_id, "queue", {"action": action})


def queue_reorder(conn, room_id, qid, index):
    ids = [row[0] for row in conn.execute(
        "SELECT id FROM room_queue WHERE room_id=? AND status='queued' ORDER BY seq,id", (room_id,))]
    if qid not in ids:
        raise RoomError(404, "待播条目不存在")
    if index >= len(ids):
        raise RoomError(400, "队列位置超出范围")
    ids.remove(qid)
    ids.insert(index, qid)
    conn.executemany("UPDATE room_queue SET seq=? WHERE id=?", enumerate(ids, 1))
    emit_event(conn, room_id, "queue", {"action": "reorder"})


def queue_target(conn, room_id, action):
    status, order = ("played", "play_order DESC,id DESC") if action == "prev" else ("queued", "seq,id")
    row = conn.execute(f"SELECT * FROM room_queue WHERE room_id=? AND status=? ORDER BY {order} LIMIT 1",
                       (room_id, status)).fetchone()
    return dict(row) if row else None


def position(room, at=None):
    elapsed = max(0, (now_ms() if at is None else at) - room["base_at"]) if room["playing"] else 0
    value = room["base_position"] + elapsed
    duration = (json.loads(room["track_meta"] or "null") or {}).get("duration") or 0
    return min(value, duration) if duration > 0 else value


def timeline(room):
    return {
        "trackNcmId": room["track_ncm_id"],
        "trackMeta": json.loads(room["track_meta"] or "null"),
        "trackRevision": room["track_revision"],
        "stream": {"url": room["stream_url"], "level": room["stream_level"],
                   "expireAt": room["stream_expire_at"]} if room["stream_url"] else None,
        "basePosition": room["base_position"], "baseAt": room["base_at"],
        "playing": bool(room["playing"]), "serverNow": now_ms(),
    }


def playback(conn, room, uid, action, changes):
    room_id = room["id"]
    update_room(conn, room_id, dict(changes, updated_at=int(time.time())))
    tl = timeline(room_by_ident(conn, str(room_id)))
    seq = emit_event(conn, room_id, action, {"by": uid, "timeline": tl})
    return {"timeline": tl, "seq": seq}


def switch_track(conn, room, uid, action, item, stream):
    room_id = room["id"]
    if not item:
        if action == "prev":
            raise RoomError(409, "没有上一首")
        return playback(conn, room, uid, action, {
            "playing": 0, "base_position": position(room), "base_at": now_ms(),
        })
    order = conn.execute("SELECT COALESCE(MAX(play_order),0)+1 FROM room_queue WHERE room_id=?",
                         (room_id,)).fetchone()[0]
    if action == "prev":
        front = conn.execute("SELECT COALESCE(MIN(seq),1)-1 FROM room_queue WHERE room_id=? AND status='queued'",
                             (room_id,)).fetchone()[0]
        conn.execute("UPDATE room_queue SET status='queued',seq=? WHERE room_id=? AND status='playing'",
                     (front, room_id))
    else:
        conn.execute("UPDATE room_queue SET status='played' WHERE room_id=? AND status='playing'", (room_id,))
    conn.execute("UPDATE room_queue SET status='playing',play_order=? WHERE id=?", (order, item["id"]))
    conn.execute("""DELETE FROM room_queue WHERE room_id=? AND status='played' AND id IN
        (SELECT id FROM room_queue WHERE room_id=? AND status='played'
         ORDER BY play_order DESC,id DESC LIMIT -1 OFFSET 50)""", (room_id, room_id))
    meta = {key: item[key] for key in ("ncm_id", "name", "artists", "pic", "duration")}
    return playback(conn, room, uid, action, dict(
        stream, track_ncm_id=item["ncm_id"], track_meta=json.dumps(meta, ensure_ascii=False),
        track_revision=room["track_revision"] + 1, base_position=0,
        base_at=now_ms() + PREBUFFER_MS, playing=1,
    ))


def emit_event(conn, room_id, kind, payload):
    seq = latest_seq(conn, room_id) + 1
    now = int(time.time())
    update_room(conn, room_id, {"updated_at": now})
    conn.execute("INSERT INTO room_events(room_id,seq,type,payload,created_at) VALUES(?,?,?,?,?)",
                 (room_id, seq, kind, json.dumps(payload, ensure_ascii=False), now))
    conn.execute("DELETE FROM room_events WHERE room_id=? AND seq<=?", (room_id, seq - MAX_EVENTS_PER_ROOM))
    return seq


def latest_seq(conn, room_id):
    return conn.execute("SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=?", (room_id,)).fetchone()[0]


def event_batch(conn, room_id, since):
    first, latest = conn.execute("SELECT MIN(seq),COALESCE(MAX(seq),0) FROM room_events WHERE room_id=?",
                                 (room_id,)).fetchone()
    if since > latest or (first is not None and since < first - 1):
        return [{"seq": latest, "type": "reset", "payload": {}, "createdAt": int(time.time())}], latest
    rows = conn.execute("SELECT * FROM room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT 50",
                        (room_id, since))
    events = []
    for row in rows:
        payload = json.loads(row["payload"])
        if row["type"] == "queue":
            payload = {"action": payload.get("action")}
        events.append({"seq": row["seq"], "type": row["type"], "payload": payload,
                       "createdAt": row["created_at"]})
    return events, latest
