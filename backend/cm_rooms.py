"""听歌房数据层：房间/成员/队列/事件/封禁 + 权威时间轴。"""
import json
import os
import secrets
import time

# 与 cm_server 同级直接导入（服务以脚本方式运行，非包）
from cm_db import connect, hash_password, get_user

MAX_EVENTS_PER_ROOM = 200


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
    conn.commit()


# ---------- 房间 ----------

def gen_room_code():
    conn = connect()
    try:
        for _ in range(20):
            code = f"{secrets.randbelow(1000000):06d}"
            if not conn.execute("SELECT 1 FROM rooms WHERE code=?", (code,)).fetchone():
                return code
        raise RuntimeError("无法生成唯一房间号")
    finally:
        conn.close()


def create_room(owner_id, name, password="", is_public=True, free_mode=False, need_approval=True):
    code = gen_room_code()
    salt = secrets.token_hex(8) if password else ""
    ph = hash_password(password, salt) if password else ""
    now = int(time.time())
    owner = get_user(owner_id)
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO rooms(code,name,owner_id,salt,password_hash,is_public,free_mode,"
            "need_approval,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (code, str(name)[:60], owner_id, salt, ph,
             1 if is_public else 0, 1 if free_mode else 0, 1 if need_approval else 0, now, now),
        )
        room_id = cur.lastrowid
        conn.execute(
            "INSERT INTO room_members(room_id,user_id,role,nickname,avatar,joined_at,last_seen)"
            " VALUES(?,?,?,?,?,?,?)",
            (room_id, owner_id, "owner", owner["nickname"] if owner else "",
             owner["avatar"] if owner else "", now, now),
        )
        conn.commit()
        return get_room(room_id)
    finally:
        conn.close()


def get_room(room_id=None, code=None):
    conn = connect()
    try:
        if code:
            r = conn.execute("SELECT * FROM rooms WHERE code=? AND closed_at=0", (code,)).fetchone()
        else:
            r = conn.execute("SELECT * FROM rooms WHERE id=? AND closed_at=0", (room_id,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def list_public_rooms(query="", limit=20, offset=0):
    conn = connect()
    try:
        where = "r.closed_at=0 AND r.is_public=1"
        args = []
        if query:
            where += " AND (r.name LIKE ? OR r.code LIKE ?)"
            args = [f"%{query}%"] * 2
        rows = conn.execute(
            f"""SELECT r.id, r.code, r.name, r.owner_id, r.free_mode, r.need_approval,
                   r.track_meta, r.playing, r.base_position, r.base_at, r.max_members,
                   (SELECT COUNT(*) FROM room_members m WHERE m.room_id=r.id AND m.last_seen >= ?) AS online,
                   u.nickname AS owner_name
            FROM rooms r LEFT JOIN users u ON u.id=r.owner_id
            WHERE {where} ORDER BY online DESC, r.updated_at DESC LIMIT ? OFFSET ?""",
            [int(time.time()) - 60] + args + [limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM rooms r WHERE {where}", args
        ).fetchone()[0]
        out = []
        for r in rows:
            d = dict(r)
            d["track_meta"] = json.loads(d["track_meta"]) if d["track_meta"] else None
            out.append(d)
        return {"total": total, "rooms": out}
    finally:
        conn.close()


def verify_room_password(room, password):
    if not room["password_hash"]:
        return True
    return hash_password(password or "", room["salt"]) == room["password_hash"]


def close_room(room_id):
    now = int(time.time())
    conn = connect()
    try:
        conn.execute("UPDATE rooms SET closed_at=?, updated_at=? WHERE id=?", (now, now, room_id))
        conn.commit()
    finally:
        conn.close()


def update_room_settings(room_id, fields):
    allowed = {"free_mode", "need_approval", "is_public", "join_locked"}
    conn = connect()
    try:
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(1 if v else 0)
        if "password" in fields:
            pw = fields["password"]
            if pw:
                salt = secrets.token_hex(8)
                sets.extend(["salt=?", "password_hash=?"])
                vals.extend([salt, hash_password(pw, salt)])
            else:
                sets.extend(["salt=?", "password_hash=?"])
                vals.extend(["", ""])
        if not sets:
            return
        sets.append("updated_at=?")
        vals.extend([int(time.time()), room_id])
        conn.execute(f"UPDATE rooms SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    finally:
        conn.close()


# ---------- 权威时间轴 ----------

PREBUFFER_MS = 1200   # 起播预留：给各端留加载/缓冲窗口，避免"服务端已开始计时而客户端还在缓冲"


def set_timeline(room_id, *, track_ncm_id=0, track_meta=None, stream_level="",
                 stream_url="", stream_expire_at=0, base_position=0, base_at=None, playing=None,
                 prebuffer=False):
    now = int(time.time()) * 1000
    conn = connect()
    try:
        sets = ["updated_at=?"]
        vals = [int(time.time())]
        if track_ncm_id:
            sets.append("track_ncm_id=?")
            vals.append(track_ncm_id)
        if track_meta is not None:
            sets.append("track_meta=?")
            vals.append(json.dumps(track_meta, ensure_ascii=False))
        if stream_level:
            sets.append("stream_level=?")
            vals.append(stream_level)
        if stream_url:
            sets.append("stream_url=?")
            vals.append(stream_url)
        if stream_expire_at:
            sets.append("stream_expire_at=?")
            vals.append(stream_expire_at)
        if base_position is not None:
            sets.append("base_position=?")
            vals.append(base_position)
        sets.append("base_at=?")
        if base_at is not None:
            vals.append(base_at)
        else:
            vals.append(now + (PREBUFFER_MS if (prebuffer and playing) else 0))
        if playing is not None:
            sets.append("playing=?")
            vals.append(1 if playing else 0)
        vals.append(room_id)
        conn.execute(f"UPDATE rooms SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    finally:
        conn.close()
    return get_room(room_id)


def get_timeline(room):
    return {
        "trackNcmId": room["track_ncm_id"],
        "trackMeta": json.loads(room["track_meta"]) if room["track_meta"] else None,
        "stream": {
            "url": room["stream_url"],
            "level": room["stream_level"],
            "expireAt": room["stream_expire_at"],
        } if room["stream_url"] else None,
        "basePosition": room["base_position"],
        "baseAt": room["base_at"],
        "playing": bool(room["playing"]),
        "serverNow": int(time.time()) * 1000,
    }


# ---------- 成员 ----------

def join_room(room_id, user_id, nickname="", avatar=""):
    now = int(time.time())
    conn = connect()
    try:
        existing = conn.execute(
            "SELECT role FROM room_members WHERE room_id=? AND user_id=?", (room_id, user_id)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE room_members SET last_seen=?, nickname=?, avatar=? WHERE room_id=? AND user_id=?",
                (now, nickname, avatar, room_id, user_id),
            )
            conn.commit()
            return existing["role"], False
        count = conn.execute(
            "SELECT COUNT(*) FROM room_members WHERE room_id=? AND last_seen >= ?",
            (room_id, now - 60),
        ).fetchone()[0]
        max_m = conn.execute("SELECT max_members FROM rooms WHERE id=?", (room_id,)).fetchone()
        if max_m and count >= max_m[0]:
            return None, "full"
        conn.execute(
            "INSERT INTO room_members(room_id,user_id,role,nickname,avatar,joined_at,last_seen)"
            " VALUES(?,?,?,?,?,?,?)",
            (room_id, user_id, "member", nickname, avatar, now, now),
        )
        conn.commit()
        return "member", True
    finally:
        conn.close()


def leave_room(room_id, user_id):
    conn = connect()
    try:
        conn.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?", (room_id, user_id))
        conn.commit()
    finally:
        conn.close()


def get_member(room_id, user_id):
    conn = connect()
    try:
        r = conn.execute(
            "SELECT * FROM room_members WHERE room_id=? AND user_id=?", (room_id, user_id)
        ).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def list_members(room_id, online_within=60):
    conn = connect()
    try:
        # 头衔/站内角色以 users 表为准（room_members 里只是入房时的昵称快照）
        rows = conn.execute(
            "SELECT rm.*, u.title AS title, u.is_admin AS is_admin, u.is_super AS is_super,"
            " u.is_owner AS is_owner"
            " FROM room_members rm LEFT JOIN users u ON u.id = rm.user_id"
            " WHERE rm.room_id=? AND rm.last_seen >= ?"
            " ORDER BY CASE rm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, rm.joined_at",
            (room_id, int(time.time()) - online_within),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def heartbeat(room_id, user_id):
    conn = connect()
    try:
        conn.execute(
            "UPDATE room_members SET last_seen=? WHERE room_id=? AND user_id=?",
            (int(time.time()), room_id, user_id),
        )
        conn.commit()
    finally:
        conn.close()


def set_role(room_id, user_id, role):
    conn = connect()
    try:
        conn.execute(
            "UPDATE room_members SET role=? WHERE room_id=? AND user_id=?", (role, room_id, user_id)
        )
        if role == "owner":
            conn.execute("UPDATE rooms SET owner_id=?, updated_at=? WHERE id=?",
                         (user_id, int(time.time()), room_id))
        conn.commit()
    finally:
        conn.close()


def kick_member(room_id, user_id, banned_by, reason="", ban=False):
    conn = connect()
    try:
        conn.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?", (room_id, user_id))
        if ban:
            conn.execute(
                "INSERT OR REPLACE INTO room_bans(room_id,user_id,reason,banned_by,created_at)"
                " VALUES(?,?,?,?,?)",
                (room_id, user_id, reason, banned_by, int(time.time())),
            )
        conn.commit()
    finally:
        conn.close()


def is_banned(room_id, user_id):
    conn = connect()
    try:
        return bool(conn.execute(
            "SELECT 1 FROM room_bans WHERE room_id=? AND user_id=?", (room_id, user_id)
        ).fetchone())
    finally:
        conn.close()


# ---------- 队列 ----------

def queue_add(room_id, meta, requested_by, auto_approve=False):
    now = int(time.time())
    conn = connect()
    try:
        status = "queued" if auto_approve else "pending"
        seq = 0
        if auto_approve:
            max_seq = conn.execute(
                "SELECT COALESCE(MAX(seq),0) FROM room_queue WHERE room_id=? AND status IN ('queued','playing')",
                (room_id,),
            ).fetchone()[0]
            seq = max_seq + 1
        cur = conn.execute(
            "INSERT INTO room_queue(room_id,ncm_id,name,artists,pic,duration,requested_by,status,seq,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (room_id, int(meta.get("ncm_id", 0)), str(meta.get("name", ""))[:200],
             str(meta.get("artists", ""))[:300], str(meta.get("pic", ""))[:500],
             int(meta.get("duration", 0)), requested_by, status, seq, now),
        )
        conn.commit()
        qid = cur.lastrowid
        return {"id": qid, "status": status, "seq": seq,
                "ncm_id": meta.get("ncm_id"), "name": meta.get("name"),
                "artists": meta.get("artists"), "pic": meta.get("pic"),
                "duration": meta.get("duration"), "requested_by": requested_by,
                "requester": ""}
    finally:
        conn.close()


def queue_review(qid, room_id, approve, reviewed_by):
    conn = connect()
    try:
        if approve:
            max_seq = conn.execute(
                "SELECT COALESCE(MAX(seq),0) FROM room_queue WHERE room_id=? AND status IN ('queued','playing')",
                (room_id,),
            ).fetchone()[0]
            conn.execute(
                "UPDATE room_queue SET status='queued', seq=?, reviewed_by=?, reviewed_at=? WHERE id=? AND room_id=? AND status='pending'",
                (max_seq + 1, reviewed_by, int(time.time()), qid, room_id),
            )
        else:
            conn.execute(
                "UPDATE room_queue SET status='rejected', reviewed_by=?, reviewed_at=? WHERE id=? AND room_id=? AND status='pending'",
                (reviewed_by, int(time.time()), qid, room_id),
            )
        conn.commit()
    finally:
        conn.close()


def queue_remove(qid, room_id):
    conn = connect()
    try:
        conn.execute("DELETE FROM room_queue WHERE id=? AND room_id=?", (qid, room_id))
        conn.commit()
    finally:
        conn.close()


def queue_list(room_id, include_pending=True):
    conn = connect()
    try:
        status_filter = "('queued','playing','played')" if not include_pending else "('pending','queued','playing','played')"
        rows = conn.execute(
            f"""SELECT q.*, u.nickname AS requester FROM room_queue q
                LEFT JOIN users u ON u.id=q.requested_by
                WHERE q.room_id=? AND q.status IN {status_filter}
                ORDER BY CASE q.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, q.seq, q.created_at""",
            (room_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def queue_pop_next(room_id):
    """弹出下一首要播的歌（seq 最小的 queued），标记为 playing。"""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM room_queue WHERE room_id=? AND status='queued' ORDER BY seq LIMIT 1",
            (room_id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE room_queue SET status='playing' WHERE id=?", (row["id"],),
        )
        conn.execute(
            "UPDATE room_queue SET status='played' WHERE room_id=? AND status='playing' AND id!=?",
            (room_id, row["id"]),
        )
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def queue_mark_all_played(room_id):
    conn = connect()
    try:
        conn.execute("UPDATE room_queue SET status='played' WHERE room_id=? AND status='playing'", (room_id,))
        conn.commit()
    finally:
        conn.close()


# ---------- 事件 ----------

_room_event_seq = {}   # room_id -> last seq（进程内缓存，避免每次查 MAX）


def emit_event(room_id, etype, payload):
    seq = _room_event_seq.get(room_id, 0) + 1
    _room_event_seq[room_id] = seq
    conn = connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO room_events(room_id,seq,type,payload,created_at) VALUES(?,?,?,?,?)",
            (room_id, seq, etype, json.dumps(payload, ensure_ascii=False), int(time.time())),
        )
        # 环形清理
        old = conn.execute(
            "SELECT seq FROM room_events WHERE room_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?",
            (room_id, MAX_EVENTS_PER_ROOM),
        ).fetchone()
        if old:
            conn.execute("DELETE FROM room_events WHERE room_id=? AND seq<=?", (room_id, old["seq"]))
        conn.commit()
    finally:
        conn.close()
    return seq


def get_events_since(room_id, since_seq):
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT 50",
            (room_id, since_seq),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_latest_seq(room_id):
    if room_id in _room_event_seq:
        return _room_event_seq[room_id]
    conn = connect()
    try:
        r = conn.execute(
            "SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=?", (room_id,)
        ).fetchone()
        _room_event_seq[room_id] = r[0]
        return r[0]
    finally:
        conn.close()
