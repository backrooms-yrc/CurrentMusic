"""CurrentMusic 后端数据库层（sqlite3 标准库，WAL，按请求建连接）。"""
import json
import logging
import os
import secrets
import sqlite3
import time

log = logging.getLogger("cm")     # 与 cm_server 同名 logger；迁移等一次性动作会打这里

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CM_DATA_DIR", os.path.join(ROOT, "data"))
DB_PATH = os.environ.get("CM_DB", os.path.join(DATA_DIR, "cm.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  token_hash TEXT DEFAULT '',
  token_at INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  is_super INTEGER DEFAULT 0,
  is_owner INTEGER DEFAULT 0,        /* 站长（最高角色）：拥有超管全部权限，广场置顶优先于超管 */
  public_square INTEGER DEFAULT 1,   /* 是否公开到「发现」页广场（1=公开） */
  disabled INTEGER DEFAULT 0,
  title TEXT DEFAULT '',             /* 站内头衔（管理员授予；''=无）。广场/主页/帖子/评论等各处展示 */
  avatar_decoration TEXT DEFAULT ''  /* 已选头像挂件 id（''=未设置）；需听歌时长达标才可设置 */
);
CREATE TABLE IF NOT EXISTS songs (
  ncm_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  artists TEXT DEFAULT '',
  album TEXT DEFAULT '',
  pic TEXT DEFAULT '',
  duration INTEGER DEFAULT 0,
  pop INTEGER DEFAULT 0,
  fee INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL,
  ncm_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, ncm_id)
);
CREATE TABLE IF NOT EXISTS favs (
  user_id INTEGER NOT NULL,
  ncm_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, ncm_id)
);
CREATE TABLE IF NOT EXISTS search_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  UNIQUE(user_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, seq DESC);
CREATE TABLE IF NOT EXISTS search_history_imports (
  user_id INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  source TEXT DEFAULT 'local',
  ncm_pl_id INTEGER DEFAULT 0,
  cover TEXT DEFAULT '',
  ncm_order INTEGER DEFAULT 0,      /* 网易云 /user/playlist 返回顺序（0=非 NCM / 未同步） */
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ncm_bindings (
  user_id INTEGER PRIMARY KEY,
  ncm_uid INTEGER DEFAULT 0,
  ncm_nickname TEXT DEFAULT '',
  ncm_avatar TEXT DEFAULT '',
  cookie TEXT NOT NULL,
  ncm_liked_pl_id INTEGER DEFAULT 0,
  bound_at INTEGER NOT NULL,
  last_sync INTEGER DEFAULT 0,
  last_sync_count INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  ncm_id INTEGER NOT NULL,
  UNIQUE(playlist_id, ncm_id)
);
CREATE TABLE IF NOT EXISTS plays (
  user_id INTEGER NOT NULL,
  ncm_id INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  -- 本次实际收听毫秒数（由前端按真实播放推进累计上报）。
  -- 旧库补列时用「相邻播放间隔（上限为曲目时长）」重建历史值，见 init() 的迁移段。
  ms INTEGER DEFAULT 0,
  -- 是否已把这次播放（满 60 秒后）写入用户绑定的网易云听歌记录。
  ncm_synced INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  tries INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS phone_codes (
  phone TEXT PRIMARY KEY,
  code TEXT DEFAULT '',        -- 自建网关模式存码；网易云通道由上游生成，此处留空
  mode TEXT DEFAULT 'ncm',
  expires INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  tries INTEGER DEFAULT 0
);
-- 短信发送流水：限流（每号码每日上限 / 每 IP 每小时上限）与审计
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  ip TEXT DEFAULT '',
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_log_phone ON sms_log(phone, sent_at);
CREATE INDEX IF NOT EXISTS idx_sms_log_ip ON sms_log(ip, sent_at);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_seen);
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_likes_song ON likes(ncm_id);
CREATE INDEX IF NOT EXISTS idx_favs_user ON favs(user_id);
CREATE INDEX IF NOT EXISTS idx_pl_owner ON playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_plt_pl ON playlist_tracks(playlist_id);
CREATE INDEX IF NOT EXISTS idx_plays_user ON plays(user_id, played_at);
/* 管理台「近 14 天播放」按时间倒序聚合，与按用户查历史的索引分开 */
CREATE INDEX IF NOT EXISTS idx_plays_at ON plays(played_at);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
/* 头像挂件目录：由 decorations/manifest.json 在启动时同步（见 cm_decor.py） */
CREATE TABLE IF NOT EXISTS decorations (
  id TEXT PRIMARY KEY,          /* 挂件 id（源站 id，用作公开标识与文件名） */
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  format TEXT DEFAULT 'gif',    /* gif / png / apng */
  file TEXT DEFAULT '',         /* decorations/ 下的文件名 */
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  scale REAL DEFAULT 1.0,       /* CSS 放大比例：把圆环外沿放大到恰好贴合头像边缘 */
  source_url TEXT DEFAULT '',
  bytes INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------- 帖子（发现页 · v1.21.15） ----------
-- content 存 **markdown 原文**；渲染在前端做（先转义再解析，避免存 HTML 带 XSS）。
-- attachments 为 JSON 数组：[{type:'song'|'album'|'artist'|'playlist', id, name, sub, pic}]，最多 5 项。
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE(post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_post ON post_comments(post_id, id);

-- ---------- CurrentStation 通行证（v1.28.17） ----------
-- 统一登录平台的数据层：应用登记 / 授权码 / 授权（令牌对）/ 审计。
-- 密码与令牌一律只存 sha256（与 sessions 同一口径）：库被读走也拿不到可用凭据。
CREATE TABLE IF NOT EXISTS passport_apps (
  key TEXT PRIMARY KEY,                       /* client_id（公开可见） */
  name TEXT NOT NULL,
  secret_hash TEXT DEFAULT '',                /* 机密客户端的 client_secret 哈希；'' = 公开客户端（必须 PKCE） */
  redirects TEXT NOT NULL DEFAULT '[]',       /* JSON 数组：回调地址，精确匹配（不允许通配） */
  scopes TEXT NOT NULL DEFAULT 'openid profile',   /* 该应用可申请的 scope 上限（空格分隔） */
  owner_uid INTEGER DEFAULT 0,
  homepage TEXT DEFAULT '',
  logo TEXT DEFAULT '',
  first_party INTEGER DEFAULT 0,              /* 一等方（Current 系自家产品）：同意页标注 */
  disabled INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passport_codes (
  code_hash TEXT PRIMARY KEY,
  app_key TEXT NOT NULL,
  uid INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  challenge TEXT DEFAULT '',                  /* PKCE code_challenge */
  method TEXT DEFAULT '',                     /* S256 / plain */
  sid TEXT DEFAULT '',                        /* 发起授权的浏览器会话（单点登出用） */
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passport_grants (
  id TEXT PRIMARY KEY,                        /* 对用户可见的授权 id（授权管理页用） */
  app_key TEXT NOT NULL,
  uid INTEGER NOT NULL,
  scope TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT DEFAULT '',
  access_expires INTEGER NOT NULL,
  refresh_expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER DEFAULT 0,
  revoked INTEGER DEFAULT 0,
  sid TEXT DEFAULT '',                        /* 授权时的会话：撤销该会话 = 单点登出 */
  device TEXT DEFAULT '',
  platform TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pp_grant_uid ON passport_grants(uid);
CREATE INDEX IF NOT EXISTS idx_pp_grant_refresh ON passport_grants(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_pp_grant_app ON passport_grants(app_key);
CREATE TABLE IF NOT EXISTS passport_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  app_key TEXT DEFAULT '',
  uid INTEGER DEFAULT 0,
  kind TEXT NOT NULL,                         /* app.create / authorize / token / refresh / revoke / userinfo ... */
  ip TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pp_event_ts ON passport_events(ts DESC);

-- ---------- 弹窗公告（v1.28.22） ----------
-- 客户端每次打开都会拉一次 /announcements 并弹窗；管理员在后台增删改（置顶/移除）。
-- removed 是软删：保留审计，管理员列表仍能看到「已移除」，但公开接口不再下发。
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,          /* 发布者（管理员 / 超级管理员） */
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT DEFAULT '',              /* 可选：详情链接（http/https） */
  pinned INTEGER DEFAULT 0,          /* 置顶（列表排最前） */
  removed INTEGER DEFAULT 0,         /* 移除（软删） */
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_live ON announcements(removed, pinned DESC, created_at DESC);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=8)
    conn.row_factory = sqlite3.Row
    # journal_mode 是持久化属性，只在 init() 设一次。以前每条连接都执行
    # PRAGMA journal_mode=WAL，高频缓存读会反复申请库锁，高峰期可能被拖住。
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


SEARCH_HISTORY_LIMIT = 10
SEARCH_KEYWORD_LIMIT = 200


def clean_search_keyword(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > SEARCH_KEYWORD_LIMIT:
        raise ValueError("keyword 需为 1–200 字符的字符串")
    return value.strip()


def _search_history_in(conn, uid):
    return [r[0] for r in conn.execute(
        "SELECT keyword FROM search_history WHERE user_id=? ORDER BY seq DESC LIMIT ?",
        (uid, SEARCH_HISTORY_LIMIT))]


def search_history(uid):
    conn = connect()
    try:
        return _search_history_in(conn, uid)
    finally:
        conn.close()


def change_search_history(uid, action, value=None):
    """Atomic per-account operations; cached device snapshots never replace cloud history."""
    if action in ("add", "remove"):
        value = clean_search_keyword(value)
    elif action == "import":
        if not isinstance(value, list) or len(value) > SEARCH_HISTORY_LIMIT:
            raise ValueError("keywords 需为最多 10 条的字符串列表")
        value = list(dict.fromkeys(clean_search_keyword(k) for k in value))
    elif action != "clear":
        raise ValueError("未知搜索历史操作")
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        imported = conn.execute("INSERT OR IGNORE INTO search_history_imports(user_id) VALUES(?)", (uid,)).rowcount
        if action == "add":
            conn.execute("INSERT OR REPLACE INTO search_history(user_id,keyword) VALUES(?,?)", (uid, value))
        elif action == "remove":
            conn.execute("DELETE FROM search_history WHERE user_id=? AND keyword=?", (uid, value))
        elif action == "clear":
            conn.execute("DELETE FROM search_history WHERE user_id=?", (uid,))
        elif imported:
            # Legacy lists are newest first. Import once per account, so another
            # device cannot bring back records that were already deleted in cloud.
            for keyword in reversed(value):
                conn.execute("INSERT OR IGNORE INTO search_history(user_id,keyword) VALUES(?,?)", (uid, keyword))
        conn.execute("DELETE FROM search_history WHERE user_id=? AND seq NOT IN "
                     "(SELECT seq FROM search_history WHERE user_id=? ORDER BY seq DESC LIMIT ?)",
                     (uid, uid, SEARCH_HISTORY_LIMIT))
        result = _search_history_in(conn, uid)
        conn.commit()
        return result
    finally:
        conn.close()


def init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = connect()
    conn.execute("PRAGMA journal_mode=WAL")
    import cm_2fa
    conn.executescript(SCHEMA + cm_2fa.SCHEMA)
    # 旧库迁移：playlists / ncm_bindings 补列（新库由 SCHEMA 直接建全）
    cols = {r[1] for r in conn.execute("PRAGMA table_info(playlists)")}
    for col, ddl in (
        ("source", "ALTER TABLE playlists ADD COLUMN source TEXT DEFAULT 'local'"),
        ("ncm_pl_id", "ALTER TABLE playlists ADD COLUMN ncm_pl_id INTEGER DEFAULT 0"),
        ("cover", "ALTER TABLE playlists ADD COLUMN cover TEXT DEFAULT ''"),
    ):
        if col not in cols:
            conn.execute(ddl)
    ucols = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
    if "email" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email != ''")
    if "phone" not in ucols:
        conn.execute("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone != ''")
    for col, ddl in (
        # v1.28.17：通行证公开标识（sub 用）。历史用户惰性生成，见 passport_uid()
        ("passport_uid", "ALTER TABLE users ADD COLUMN passport_uid TEXT DEFAULT ''"),
        ("is_admin", "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"),
        ("is_super", "ALTER TABLE users ADD COLUMN is_super INTEGER DEFAULT 0"),
        # 站长：最高角色（隐含超管+管理员）
        ("is_owner", "ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0"),
        ("public_square", "ALTER TABLE users ADD COLUMN public_square INTEGER DEFAULT 1"),
        ("disabled", "ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0"),
        # 站内头衔：管理员/超管授予，空串=无（广场/主页/帖子/评论等各处展示）
        ("title", "ALTER TABLE users ADD COLUMN title TEXT DEFAULT ''"),
        # v1.18.0 头像挂件：仅存挂件 id，元数据在 decorations 表中
        ("avatar_decoration", "ALTER TABLE users ADD COLUMN avatar_decoration TEXT DEFAULT ''"),
        # v1.28.38 IP 属地：只存省份/国家（如「安徽」/「美国」），不存原始 IP
        ("ip_region", "ALTER TABLE users ADD COLUMN ip_region TEXT DEFAULT ''"),
        # v1.28.51 AI 账号标记（聊天里的 AI 徽章；广场不展示）
        ("is_bot", "ALTER TABLE users ADD COLUMN is_bot INTEGER DEFAULT 0"),
    ):
        if col not in ucols:
            conn.execute(ddl)
    # 迁移：旧的单 token（users.token_hash）→ 会话表，避免升级把在线用户踢下线
    legacy = conn.execute(
        "SELECT id, token_hash, token_at FROM users WHERE token_hash != '' "
        "AND token_hash NOT IN (SELECT token_hash FROM sessions)"
    ).fetchall()
    for uid, th, at in legacy:
        conn.execute(
            "INSERT OR IGNORE INTO sessions(token_hash,user_id,device,platform,created_at,last_seen)"
            " VALUES(?,?,?,?,?,?)",
            (th, uid, "升级前的设备", "app", at or int(time.time()), at or int(time.time())),
        )
    bcols = {r[1] for r in conn.execute("PRAGMA table_info(ncm_bindings)")}
    if "ncm_liked_pl_id" not in bcols:
        conn.execute("ALTER TABLE ncm_bindings ADD COLUMN ncm_liked_pl_id INTEGER DEFAULT 0")
    # decorations 表后加的列（老库补列；新库由 SCHEMA 直接建全）
    if conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='decorations'").fetchone():
        dcols = {r[1] for r in conn.execute("PRAGMA table_info(decorations)")}
        if "scale" not in dcols:
            conn.execute("ALTER TABLE decorations ADD COLUMN scale REAL DEFAULT 1.0")
    # 迁移：playlists 增加 ncm_order（网易云 /user/playlist 的返回顺序）。
    # 旧库先用 id 作为稳定初值，避免全部为 0；下一次 /ncmbind/sync 会用上游顺序覆盖。
    plcols = {r[1] for r in conn.execute("PRAGMA table_info(playlists)")}
    if "ncm_order" not in plcols:
        conn.execute("ALTER TABLE playlists ADD COLUMN ncm_order INTEGER DEFAULT 0")
        conn.execute("UPDATE playlists SET ncm_order=id WHERE source='ncm'")
        log.info("playlists.ncm_order 已补列（按首次导入顺序初始化，待下次同步校准）")
    # 旧库必须先补列，再建引用该列的索引，否则启动会在 executescript 阶段失败。
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pl_ncm_order ON playlists(user_id, source, ncm_order)")
    # 迁移：plays 增加 ms 列（实际收听毫秒）。旧口径是 SUM(曲目时长) —— 只跟"点开过多少首
    # 不同的歌"有关：跳歌按整首计（虚高），同曲重播只留最后一条（虚低），与真实收听无关。
    # 这里一次性把历史值重建为一个诚实的估计：min(下次播放 - 本次播放, 曲目时长)，
    # 最后一次播放按 min(now - 播放时刻, 曲目时长)。此后由前端上报真实收听毫秒。
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(plays)")}
    if "ms" not in pcols:
        conn.execute("ALTER TABLE plays ADD COLUMN ms INTEGER DEFAULT 0")
        now_ms = int(time.time() * 1000)
        conn.execute(
            """
            WITH ordered AS (
              SELECT p.rowid AS rid, p.played_at * 1000 AS at_ms,
                     COALESCE(s.duration, 0) AS dur,
                     LEAD(p.played_at * 1000) OVER (
                       PARTITION BY p.user_id ORDER BY p.played_at, p.rowid) AS next_ms
                FROM plays p LEFT JOIN songs s ON s.ncm_id = p.ncm_id
            )
            UPDATE plays SET ms = (
              SELECT MAX(0, MIN(CASE WHEN o.dur > 0 THEN o.dur ELSE 0 END,
                                 COALESCE(o.next_ms, :now) - o.at_ms))
                FROM ordered o WHERE o.rid = plays.rowid
            )
            """,
            {"now": now_ms},
        )
        log.info("plays.ms 已补列，历史听歌时长按「相邻播放间隔（上限为曲目时长）」重建 %d 行",
                 conn.execute("SELECT COUNT(*) FROM plays").fetchone()[0])
    if "ncm_synced" not in pcols:
        conn.execute("ALTER TABLE plays ADD COLUMN ncm_synced INTEGER DEFAULT 0")
    # v1.17.24 曾有自建关注表，关注已改为同步网易云账号，这里清理遗留表
    conn.execute("DROP TABLE IF EXISTS artist_follows")
    conn.commit()
    conn.close()
    # 头像挂件目录同步（清单文件缺失/损坏时静默跳过，不影响服务启动）
    try:
        import cm_decor
        n = cm_decor.sync_catalog()
        print(f"[cm_db] 头像挂件目录已同步 {n} 项", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[cm_db] 头像挂件目录同步失败（忽略）: {e}", flush=True)


# ---------- 歌曲元数据 ----------

def upsert_song(meta):
    """meta: {ncm_id,name,artists,album,pic,duration,pop,fee}，字段尽量保留旧值。"""
    if not isinstance(meta, dict) or not meta.get("ncm_id") or not meta.get("name"):
        return False
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM songs WHERE ncm_id=?", (int(meta["ncm_id"]),)).fetchone()
        if row:
            conn.execute(
                "UPDATE songs SET name=?,artists=?,album=?,pic=?,duration=?,pop=?,fee=? WHERE ncm_id=?",
                (
                    meta.get("name") or row["name"],
                    meta.get("artists") or row["artists"],
                    meta.get("album") or row["album"],
                    meta.get("pic") or row["pic"],
                    int(meta.get("duration") or row["duration"] or 0),
                    int(meta.get("pop") or row["pop"] or 0),
                    int(meta.get("fee") if meta.get("fee") is not None else row["fee"] or 0),
                    int(meta["ncm_id"]),
                ),
            )
        else:
            conn.execute(
                "INSERT OR IGNORE INTO songs(ncm_id,name,artists,album,pic,duration,pop,fee,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    int(meta["ncm_id"]),
                    str(meta["name"])[:200],
                    str(meta.get("artists") or "")[:300],
                    str(meta.get("album") or "")[:200],
                    str(meta.get("pic") or "")[:500],
                    int(meta.get("duration") or 0),
                    int(meta.get("pop") or 0),
                    int(meta.get("fee") or 0),
                    int(time.time()),
                ),
            )
        conn.commit()
        return True
    finally:
        conn.close()


def upsert_songs_many(metas):
    """批量写入歌曲元数据（单连接单事务，NCM 同步用）。字段留空时保留旧值。"""
    rows = []
    for m in metas or []:
        if not isinstance(m, dict) or not m.get("ncm_id") or not m.get("name"):
            continue
        rows.append((
            int(m["ncm_id"]), str(m["name"])[:200], str(m.get("artists") or "")[:300],
            str(m.get("album") or "")[:200], str(m.get("pic") or "")[:500],
            int(m.get("duration") or 0), int(m.get("pop") or 0), int(m.get("fee") or 0),
            int(time.time()),
        ))
    if not rows:
        return 0
    conn = connect()
    try:
        conn.executemany(
            "INSERT INTO songs(ncm_id,name,artists,album,pic,duration,pop,fee,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(ncm_id) DO UPDATE SET"
            " name=CASE WHEN excluded.name!='' THEN excluded.name ELSE songs.name END,"
            " artists=CASE WHEN excluded.artists!='' THEN excluded.artists ELSE songs.artists END,"
            " album=CASE WHEN excluded.album!='' THEN excluded.album ELSE songs.album END,"
            " pic=CASE WHEN excluded.pic!='' THEN excluded.pic ELSE songs.pic END,"
            " duration=CASE WHEN excluded.duration>0 THEN excluded.duration ELSE songs.duration END,"
            " pop=CASE WHEN excluded.pop>0 THEN excluded.pop ELSE songs.pop END,"
            " fee=CASE WHEN excluded.fee>0 THEN excluded.fee ELSE songs.fee END",
            rows,
        )
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def songs_by_ids(ncm_ids):
    if not ncm_ids:
        return []
    conn = connect()
    try:
        marks = ",".join("?" * len(ncm_ids))
        rows = conn.execute(
            f"SELECT * FROM songs WHERE ncm_id IN ({marks})", list(ncm_ids)
        ).fetchall()
        # SQL IN 不保证返回顺序：按调用方给的 id 顺序重排（最近播放/收藏列表依赖顺序）
        by_id = {r["ncm_id"]: dict(r) for r in rows}
        return [by_id[i] for i in ncm_ids if i in by_id]
    finally:
        conn.close()


def song_rows_to_meta(rows):
    return [
        {
            "ncm_id": r["ncm_id"], "name": r["name"], "artists": r["artists"],
            "album": r["album"], "pic": r["pic"], "duration": r["duration"],
            "pop": r["pop"], "fee": r["fee"],
        }
        for r in rows
    ]


# ---------- 邮箱验证码 ----------

def get_email_code(email):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM email_codes WHERE email=?", (email,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def save_email_code(email, code, ttl):
    conn = connect()
    now = int(time.time())
    try:
        conn.execute(
            "INSERT INTO email_codes(email,code,expires,sent_at,tries) VALUES(?,?,?,?,0)"
            " ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires=excluded.expires,"
            " sent_at=excluded.sent_at, tries=0",
            (email, code, now + ttl, now),
        )
        conn.commit()
    finally:
        conn.close()


def bump_email_code_tries(email):
    conn = connect()
    try:
        conn.execute("UPDATE email_codes SET tries=tries+1 WHERE email=?", (email,))
        conn.commit()
    finally:
        conn.close()


def delete_email_code(email):
    conn = connect()
    try:
        conn.execute("DELETE FROM email_codes WHERE email=?", (email,))
        conn.commit()
    finally:
        conn.close()


def get_user_by_email(email):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM users WHERE email=? AND email!='' LIMIT 1", (email,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def email_taken(email):
    conn = connect()
    try:
        return bool(conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone())
    finally:
        conn.close()


# ---------- 手机短信验证码 ----------

def get_phone_code(phone):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM phone_codes WHERE phone=?", (phone,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def save_phone_code(phone, code, ttl, mode="ncm"):
    conn = connect()
    now = int(time.time())
    try:
        conn.execute(
            "INSERT INTO phone_codes(phone,code,mode,expires,sent_at,tries) VALUES(?,?,?,?,?,0)"
            " ON CONFLICT(phone) DO UPDATE SET code=excluded.code, mode=excluded.mode,"
            " expires=excluded.expires, sent_at=excluded.sent_at, tries=0",
            (phone, str(code or ""), mode, now + ttl, now),
        )
        conn.commit()
    finally:
        conn.close()


def bump_phone_code_tries(phone):
    conn = connect()
    try:
        conn.execute("UPDATE phone_codes SET tries=tries+1 WHERE phone=?", (phone,))
        conn.commit()
    finally:
        conn.close()


def delete_phone_code(phone):
    conn = connect()
    try:
        conn.execute("DELETE FROM phone_codes WHERE phone=?", (phone,))
        conn.commit()
    finally:
        conn.close()


def phone_taken(phone):
    conn = connect()
    try:
        return bool(conn.execute("SELECT 1 FROM users WHERE phone=?", (phone,)).fetchone())
    finally:
        conn.close()


def sms_log_add(phone, ip=""):
    conn = connect()
    try:
        conn.execute("INSERT INTO sms_log(phone,ip,sent_at) VALUES(?,?,?)",
                     (phone, str(ip or "")[:64], int(time.time())))
        conn.commit()
    finally:
        conn.close()


def sms_quota_state(phone, ip=""):
    """返回 (该号码最近一次发送时间, 号码 24h 内次数, IP 1h 内次数)。"""
    now = int(time.time())
    conn = connect()
    try:
        row = conn.execute("SELECT MAX(sent_at) FROM sms_log WHERE phone=?", (phone,)).fetchone()
        last = int(row[0] or 0)
        day = conn.execute("SELECT COUNT(*) FROM sms_log WHERE phone=? AND sent_at>=?",
                           (phone, now - 86400)).fetchone()[0]
        hour = conn.execute("SELECT COUNT(*) FROM sms_log WHERE ip=? AND sent_at>=?",
                            (ip, now - 3600)).fetchone()[0] if ip else 0
        return last, int(day), int(hour)
    finally:
        conn.close()


# ---------- 用户 ----------

def hash_password(password, salt):
    import hashlib
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()


def create_user(username, password, nickname, email="", phone=""):
    salt = secrets.token_hex(8)
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO users(username,email,phone,pass_hash,salt,nickname,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (username, str(email or ""), str(phone or ""), hash_password(password, salt), salt,
             nickname, int(time.time())),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_user_by_name(username):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def get_user(uid):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def get_user_by_phone(phone):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM users WHERE phone=?", (str(phone or ""),)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def verify_login(username, password):
    """账号标识支持用户名或手机号（手机号注册的用户可直接用手机号登录）。"""
    u = get_user_by_name(username)
    if not u and username.isdigit():
        u = get_user_by_phone(username)
    if not u:
        return None
    if hash_password(password, u["salt"]) != u["pass_hash"]:
        return None
    if u.get("is_bot"):
        raise PermissionError("系统机器人账号不可登录")
    if u.get("disabled"):
        raise PermissionError("该账号已被禁用，请联系管理员")
    return u


def issue_token(uid, device="", platform="", *, _conn=None):
    """签发新会话；设备数量不设上限，已有会话由用户或安全操作主动撤销。"""
    token = secrets.token_urlsafe(32)
    import hashlib
    th = hashlib.sha256(token.encode()).hexdigest()
    now = int(time.time())
    conn = _conn if _conn is not None else connect()
    try:
        conn.execute(
            "INSERT INTO sessions(token_hash,user_id,device,platform,created_at,last_seen)"
            " VALUES(?,?,?,?,?,?)",
            (th, uid, str(device or "")[:120], str(platform or "")[:20], now, now),
        )
        conn.execute("UPDATE users SET token_hash=?, token_at=? WHERE id=?", (th, now, uid))
        if _conn is None:
            conn.commit()
    finally:
        if _conn is None:
            conn.close()
    return token


def revoke_token(uid, token=None):
    """登出：给了 token 只登出该设备；否则登出全部设备。"""
    import hashlib
    conn = connect()
    try:
        if token:
            th = hashlib.sha256(token.encode()).hexdigest()
            conn.execute("DELETE FROM sessions WHERE user_id=? AND token_hash=?", (uid, th))
            _pp_revoke_sid_in(conn, th)                    # 单点登出：该会话的通行证授权同撤
        else:
            # 登出全部设备：撤销该用户全部通行证授权（否则令牌还能继续用）
            conn.execute("UPDATE passport_grants SET revoked=1 WHERE uid=?", (uid,))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        conn.execute("UPDATE users SET token_hash='' WHERE id=?", (uid,))
        conn.commit()
    finally:
        conn.close()


def user_by_token(token):
    """校验会话并按需刷新 last_seen（60s 节流，避免每次请求都写库）。"""
    import hashlib
    th = hashlib.sha256(token.encode()).hexdigest()
    conn = connect()
    try:
        r = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=?", (th,)
        ).fetchone()
        if not r or r["disabled"]:
            return None
        now = int(time.time())
        s = conn.execute("SELECT last_seen FROM sessions WHERE token_hash=?", (th,)).fetchone()
        if s and now - (s["last_seen"] or 0) > 60:
            conn.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now, th))
            conn.commit()
        return dict(r)
    finally:
        conn.close()


def list_sessions(uid, current_token=None):
    """该账号的在线设备列表；current 标记当前设备。"""
    import hashlib
    cur = hashlib.sha256((current_token or "").encode()).hexdigest()
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT token_hash, device, platform, created_at, last_seen FROM sessions"
            " WHERE user_id=? ORDER BY last_seen DESC", (uid,)
        ).fetchall()
        out = []
        for r in rows:
            out.append({
                "id": r["token_hash"][:16],
                "device": r["device"] or "未知设备",
                "platform": r["platform"] or "",
                "createdAt": r["created_at"],
                "lastSeen": r["last_seen"],
                "current": r["token_hash"] == cur,
            })
        return out
    finally:
        conn.close()


def revoke_session(uid, session_id):
    """按会话 id 前缀精确踢出某设备（同时撤销该会话的通行证授权 = 单点登出）。"""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT token_hash FROM sessions WHERE user_id=? AND substr(token_hash,1,length(?))=?",
            (uid, session_id, session_id),
        ).fetchall()
        for r in rows:
            _pp_revoke_sid_in(conn, r["token_hash"])
        cur = conn.execute(
            "DELETE FROM sessions WHERE user_id=? AND substr(token_hash,1,length(?))=?",
            (uid, session_id, session_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def _pp_revoke_sid_in(conn, sid):
    """在同一连接里撤销某会话的通行证授权（供上面几个会话函数复用；不单独提交）。"""
    if not sid:
        return
    try:
        conn.execute("UPDATE passport_grants SET revoked=1 WHERE sid=?", (sid,))
    except sqlite3.OperationalError:
        pass          # 老库尚未迁移到通行证版本：忽略


def set_admin(uid, on=True):
    conn = connect()
    try:
        conn.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if on else 0, uid))
        conn.commit()
    finally:
        conn.close()


# 头衔长度上限（按字符数；中文一个头衔通常 2~8 字）
TITLE_MAX = 16


def clean_title(raw):
    """规整头衔：去掉首尾空白与换行/控制字符、压缩连续空白（不做截断，长度校验留给调用方）。"""
    s = str(raw or "").replace("\r", " ").replace("\n", " ").strip()
    s = "".join(ch for ch in s if ch >= " " or ch == "\t")   # 去掉控制字符
    s = " ".join(s.split())                                  # 压缩连续空白
    return s


def set_title(uid, title):
    """设置/清空站内头衔（''=无）。返回落库后的头衔。调用方负责权限与长度校验。"""
    t = clean_title(title)[:TITLE_MAX]
    conn = connect()
    try:
        conn.execute("UPDATE users SET title=? WHERE id=?", (t, int(uid)))
        conn.commit()
        return t
    finally:
        conn.close()


def set_disabled(uid, on=True):
    """禁用账号：立即作废其全部会话。"""
    conn = connect()
    try:
        conn.execute("UPDATE users SET disabled=? WHERE id=?", (1 if on else 0, uid))
        if on:
            conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        conn.commit()
    finally:
        conn.close()


def is_disabled(uid):
    conn = connect()
    try:
        r = conn.execute("SELECT disabled FROM users WHERE id=?", (uid,)).fetchone()
        return bool(r and r["disabled"])
    finally:
        conn.close()


def _admin_daily_series(conn, sql, days, fields):
    """把「按天 GROUP BY」的统计补齐成连续 days 天（缺失日补 0）。

    管理台图表不能把「没有数据的那天」跳过去——否则 x 轴看起来是等距的，
    实际日期却断档，趋势会被误读。这里由服务端按服务器本地时区补齐，
    前端只负责画图，不需要再猜时区。
    """
    from datetime import date, timedelta

    today = date.today()
    start = today - timedelta(days=days - 1)
    start_epoch = int(time.mktime((start.year, start.month, start.day, 0, 0, 0, 0, 0, -1)))
    rows = conn.execute(sql, (start_epoch,)).fetchall()
    by_day = {r["day"]: r for r in rows}
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        key = d.isoformat()
        r = by_day.get(key)
        item = {"t": int(time.mktime((d.year, d.month, d.day, 0, 0, 0, 0, 0, -1))), "day": key}
        for f in fields:
            item[f] = int(r[f] or 0) if r is not None else 0
        out.append(item)
    return out


def admin_overview():
    """管理面板概览统计。"""
    conn = connect()
    try:
        now = int(time.time())
        day = now - 86400
        week = now - 7 * 86400
        q = lambda sql, args=(): conn.execute(sql, args).fetchone()[0]
        users = q("SELECT COUNT(*) FROM users WHERE username != '__internal__'")
        admins = q("SELECT COUNT(*) FROM users WHERE is_admin = 1")
        supers = q("SELECT COUNT(*) FROM users WHERE is_super = 1")
        owners = q("SELECT COUNT(*) FROM users WHERE is_owner = 1")
        return {
            "users": users,
            "usersToday": q("SELECT COUNT(*) FROM users WHERE created_at >= ?", (day,)),
            "usersWeek": q("SELECT COUNT(*) FROM users WHERE created_at >= ?", (week,)),
            "disabled": q("SELECT COUNT(*) FROM users WHERE disabled = 1"),
            "admins": admins,
            "supers": supers,
            "owners": owners,
            "sessions": q("SELECT COUNT(*) FROM sessions"),
            "onlineUsers": q("SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_seen >= ?", (now - 3600,)),
            "likes": q("SELECT COUNT(*) FROM likes"),
            # 网易云侧红心：按绑定账号的「我喜欢的音乐」快照统计，按 (用户, 歌曲) 去重，
            # 与站内 likes 互斥（客户端红心只会写其中一侧）。管理台「总点赞数」= 两者之和。
            "ncmLikes": q("""SELECT COUNT(*) FROM (
                SELECT DISTINCT p.user_id, pt.ncm_id
                FROM playlist_tracks pt
                JOIN playlists p ON p.id = pt.playlist_id
                JOIN ncm_bindings b ON b.user_id = p.user_id AND b.ncm_liked_pl_id = p.ncm_pl_id
                WHERE p.ncm_pl_id > 0
            )"""),
            "playlists": q("SELECT COUNT(*) FROM playlists"),
            "tracks": q("SELECT COUNT(*) FROM playlist_tracks"),
            "plays": q("SELECT COUNT(*) FROM plays"),
            "bindings": q("SELECT COUNT(*) FROM ncm_bindings"),
            "songs": q("SELECT COUNT(*) FROM songs"),
            "cache": q("SELECT COUNT(*) FROM cache"),
            "titleMax": TITLE_MAX,     # 头衔长度上限（前端弹窗据此限长，避免与后端校验漂移）
            "now": now,
            # 角色不重叠计数（站长 > 超管 > 管理员 > 普通用户）
            "roleCounts": {
                "owner": owners,
                "super": max(0, supers - owners),
                "admin": max(0, admins - supers),
                "user": max(0, users - admins),
            },
            # 近 30 天注册 / 近 14 天播放与活跃用户：管理台趋势图数据
            "userDaily": _admin_daily_series(
                conn,
                "SELECT date(created_at,'unixepoch','localtime') day, COUNT(*) count"
                " FROM users WHERE username != '__internal__' AND created_at >= ?"
                " GROUP BY day ORDER BY day",
                30, ("count",)),
            "playDaily": _admin_daily_series(
                conn,
                "SELECT date(played_at,'unixepoch','localtime') day, COUNT(*) plays,"
                " COUNT(DISTINCT user_id) users, COALESCE(SUM(ms),0) ms"
                " FROM plays WHERE played_at >= ? GROUP BY day ORDER BY day",
                14, ("plays", "users", "ms")),
        }
    finally:
        conn.close()


# ---------- 头像挂件 ----------

# 解锁门槛：累计听歌时长（按曲目实际时长累计，与广场/主页同一口径）
DECOR_MIN_MS = 2 * 60 * 60 * 1000


def listen_ms(uid):
    """某用户累计听歌时长（毫秒）：**实际收听毫秒数**之和（plays.ms）。

    旧口径 SUM(songs.duration) 只反映"点开过多少首不同的歌"：跳歌按整首计、
    同曲重播只留最后一条，两头都不对。现在由前端按真实播放推进累计上报。
    """
    conn = connect()
    try:
        return int(conn.execute(
            "SELECT COALESCE(SUM(ms),0) d FROM plays WHERE user_id=?", (int(uid),)
        ).fetchone()["d"])
    finally:
        conn.close()


def decor_unlocked(uid, ms=None):
    """听歌时长是否已达挂件解锁门槛。"""
    return (listen_ms(uid) if ms is None else int(ms)) >= DECOR_MIN_MS


def set_avatar_decoration(uid, decoration_id):
    """设置用户头像挂件（空串=不佩戴）。调用方负责校验 id 存在与解锁门槛。"""
    conn = connect()
    try:
        conn.execute("UPDATE users SET avatar_decoration=? WHERE id=?",
                     (str(decoration_id or "")[:32], int(uid)))
        conn.commit()
        return True
    finally:
        conn.close()


def set_public_square(uid, on=True):
    """是否在「发现」页广场公开自己。"""
    conn = connect()
    try:
        conn.execute("UPDATE users SET public_square=? WHERE id=?", (1 if on else 0, int(uid)))
        conn.commit()
    finally:
        conn.close()


def decor_of_users(uids):
    """批量取「用户 id → 已选挂件 id」（房间成员等列表用，避免逐条查库）。"""
    uids = [int(i) for i in (uids or []) if i]
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    conn = connect()
    try:
        rows = conn.execute(
            f"SELECT id, avatar_decoration FROM users WHERE id IN ({marks}) "
            f"AND avatar_decoration != ''", uids).fetchall()
        return {r["id"]: r["avatar_decoration"] for r in rows}
    finally:
        conn.close()


def set_super(uid, on=True):
    """设置/取消超级管理员（广场恒置顶）。授予时同时置 is_admin=1（超管必然也是管理员）。"""
    conn = connect()
    try:
        if on:
            conn.execute("UPDATE users SET is_super=1, is_admin=1 WHERE id=?", (int(uid),))
        else:
            conn.execute("UPDATE users SET is_super=0 WHERE id=?", (int(uid),))
        conn.commit()
    finally:
        conn.close()


def set_owner(uid, on=True):
    """设置/取消站长（最高角色）。授予时同时置 is_super=1、is_admin=1；
    取消只摘掉站长头衔（回落到超级管理员，不清空其超管权限）。"""
    conn = connect()
    try:
        if on:
            conn.execute("UPDATE users SET is_owner=1, is_super=1, is_admin=1 WHERE id=?", (int(uid),))
        else:
            conn.execute("UPDATE users SET is_owner=0 WHERE id=?", (int(uid),))
        conn.commit()
    finally:
        conn.close()


def get_super() -> dict:
    """当前超级管理员（唯一，取最早设置者）。"""
    conn = connect()
    try:
        r = conn.execute(
            "SELECT id, username, nickname FROM users WHERE is_super=1 ORDER BY id LIMIT 1"
        ).fetchone()
        return dict(r) if r else {}
    finally:
        conn.close()


_ADMIN_USER_SORTS = {
    "reg": "u.created_at DESC",                                  # 注册最新（默认）
    "reg_asc": "u.created_at ASC",                               # 注册最早
    "name": "u.nickname COLLATE NOCASE ASC, u.id ASC",           # 昵称
    "active": "last_seen DESC, u.created_at DESC",               # 最近活跃
    "sessions": "sessions DESC, last_seen DESC",                 # 在线设备
    "likes": "likes DESC, u.created_at DESC",                    # 点赞数
    "plays": "plays DESC, u.created_at DESC",                    # 播放数
    "role": "u.is_owner DESC, u.is_super DESC, u.is_admin DESC, u.created_at DESC",
}


def admin_list_users(query="", limit=20, offset=0, sort="reg"):
    """管理台用户列表：搜索 + 分页 + 白名单排序（sort 不合法回落到注册最新）。"""
    order = _ADMIN_USER_SORTS.get(sort, _ADMIN_USER_SORTS["reg"])
    conn = connect()
    try:
        where, args = "", []
        if query:
            where = "WHERE u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ? OR u.phone LIKE ?"
            args = [f"%{query}%"] * 4
        rows = conn.execute(
            f"""SELECT u.id, u.username, u.nickname, u.avatar, u.avatar_decoration,
                   u.email, u.phone, u.created_at, u.is_admin, u.is_super, u.is_owner, u.disabled,
                   u.title,
                   (SELECT COUNT(*) FROM likes l WHERE l.user_id=u.id) AS likes,
                   (SELECT COUNT(*) FROM playlists p WHERE p.user_id=u.id) AS playlists,
                   (SELECT COUNT(*) FROM plays pl WHERE pl.user_id=u.id) AS plays,
                   (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id) AS sessions,
                   (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=u.id) AS last_seen,
                   (SELECT COUNT(*) FROM ncm_bindings b WHERE b.user_id=u.id) AS bound
            FROM users u {where}
            ORDER BY {order} LIMIT ? OFFSET ?""",
            args + [limit, offset],
        ).fetchall()
        total = conn.execute(f"SELECT COUNT(*) FROM users u {where}", args).fetchone()[0]
        users = []
        for r in rows:
            d = dict(r)
            d["avatarDecoration"] = d.get("avatar_decoration") or ""
            users.append(d)
        return {"total": total, "users": users}
    finally:
        conn.close()


# ---------- 用户广场 / 公开主页 ----------

_SQUARE_SORTS = {
    "reg": "u.created_at DESC",            # 注册时间（默认，最新在前）
    "reg_asc": "u.created_at ASC",
    "name": "u.nickname COLLATE NOCASE ASC",
    "days": "days DESC",                   # 听歌天数
    "listen": "listenMs DESC",             # 听歌时长（实际收听毫秒累计，见 listen_ms）
    "likes": "likes DESC",                 # 点赞数
}

# 发现 → 用户页：站长 Rcst20 始终置顶（与当前排序、角色顺序无关）。
# 只影响 ORDER BY，不绕过 WHERE：搜索/仅显示在听歌/关闭公开/禁用时仍按各过滤条件生效。
SQUARE_PINNED_USERNAME = "Rcst20"

# 「正在听歌」判定窗口（秒）：与广场头部统计、个人主页「当前在听」一致
LISTENING_WINDOW = 300


def square_stats():
    """广场页头部统计：总注册用户数 + 公开用户中的当前在听人数。

    “正在听歌”必须与 ``square_users(listening_only=True)`` 使用同一套可见性过滤，
    否则关闭公开资料/被禁用的用户会让头部数字大于列表人数。
    """
    conn = connect()
    try:
        users = conn.execute(
            "SELECT COUNT(*) FROM users WHERE username != '__internal__'"
        ).fetchone()[0]
        listening = conn.execute(
            """SELECT COUNT(DISTINCT p.user_id) FROM plays p
                 JOIN users u ON u.id=p.user_id
                WHERE p.played_at >= ? AND u.disabled=0
                  AND u.username != '__internal__' AND u.public_square=1""",
            (int(time.time()) - LISTENING_WINDOW,),
        ).fetchone()[0]
        return {"users": int(users), "listening": int(listening)}
    finally:
        conn.close()


# ---------- 帖子（发现页） ----------
POST_TYPES = ("song", "album", "artist", "playlist")
POST_MAX_LEN = 5000
POST_MAX_ATTACH = 5


def _post_atts(raw):
    try:
        a = json.loads(raw or "[]")
    except Exception:
        return []
    return a if isinstance(a, list) else []


def _admin_ids():
    c = connect()
    try:
        return {r[0] for r in c.execute("SELECT id FROM users WHERE is_admin = 1 OR is_super = 1")}
    finally:
        c.close()


def posts_list(viewer_id, offset=0, limit=20, author_id=None):
    """帖子流（新→旧）：一次带出作者、点赞数、评论数、是否已赞、能否删除。"""
    lim = max(1, min(int(limit), 50))
    off = max(0, int(offset))
    where, args = "", []
    if author_id is not None:
        where = " WHERE p.user_id = ?"
        args.append(int(author_id))
    c = connect()
    try:
        rows = c.execute(
            "SELECT p.id, p.user_id, p.content, p.attachments, p.created_at, "
            "u.id AS _uid, u.nickname, u.avatar, u.avatar_decoration, u.is_admin, u.is_super, u.is_owner, u.title "
            "FROM posts p JOIN users u ON u.id = p.user_id" + where +
            " ORDER BY p.id DESC LIMIT ? OFFSET ?", args + [lim, off]).fetchall()
        ids = [r["id"] for r in rows]
        likes, cmts, liked = {}, {}, set()
        if ids:
            ph = ",".join("?" * len(ids))
            for r in c.execute(f"SELECT post_id, COUNT(*) n FROM post_likes WHERE post_id IN ({ph}) GROUP BY post_id", ids):
                likes[r["post_id"]] = r["n"]
            for r in c.execute(f"SELECT post_id, COUNT(*) n FROM post_comments WHERE post_id IN ({ph}) GROUP BY post_id", ids):
                cmts[r["post_id"]] = r["n"]
            if viewer_id:
                for r in c.execute(f"SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN ({ph})",
                                   [viewer_id] + ids):
                    liked.add(r["post_id"])
        admins = _admin_ids()
    finally:
        c.close()
    out = []
    for r in rows:
        uid, pid = r["user_id"], r["id"]
        out.append({
            "id": pid,
            "content": r["content"],
            "attachments": _post_atts(r["attachments"]),
            "createdAt": r["created_at"],
            "author": {
                "id": uid, "nickname": r["nickname"], "avatar": r["avatar"],
                "avatarDecoration": r["avatar_decoration"],
                "isAdmin": bool(r["is_admin"]), "isSuper": bool(r["is_super"]),
                "isOwner": bool(r["is_owner"]),
                "title": r["title"] or "",
            },
            "likeCount": likes.get(pid, 0),
            "commentCount": cmts.get(pid, 0),
            "likedByMe": pid in liked,
            "canDelete": viewer_id is not None and (viewer_id == uid or viewer_id in admins),
        })
    return out


def post_create(user_id, content, attachments):
    content = (content or "").strip()
    if not content:
        raise ValueError("内容不能为空")
    if len(content) > POST_MAX_LEN:
        raise ValueError("内容过长（最多 %d 字）" % POST_MAX_LEN)
    raw = attachments if isinstance(attachments, str) else json.dumps(attachments or [], ensure_ascii=False)
    atts = [a for a in _post_atts(raw)
            if isinstance(a, dict) and a.get("type") in POST_TYPES and a.get("id") is not None]
    if len(atts) > POST_MAX_ATTACH:
        raise ValueError("附带内容最多 %d 项" % POST_MAX_ATTACH)
    now = int(time.time())
    c = connect()
    try:
        cur = c.execute(
            "INSERT INTO posts(user_id, content, attachments, created_at) VALUES(?,?,?,?)",
            (int(user_id), content, json.dumps(atts, ensure_ascii=False), now))
        c.commit()
        return cur.lastrowid
    finally:
        c.close()


def post_delete(user_id, post_id):
    """作者或管理员可删。"""
    c = connect()
    try:
        r = c.execute("SELECT user_id FROM posts WHERE id = ?", (int(post_id),)).fetchone()
        if not r:
            return False
        if int(user_id) != r["user_id"] and int(user_id) not in _admin_ids():
            return False
        c.execute("DELETE FROM posts WHERE id = ?", (int(post_id),))
        c.execute("DELETE FROM post_likes WHERE post_id = ?", (int(post_id),))
        c.execute("DELETE FROM post_comments WHERE post_id = ?", (int(post_id),))
        c.commit()
        return True
    finally:
        c.close()


def post_set_like(user_id, post_id, on):
    c = connect()
    try:
        if on:
            c.execute("INSERT OR IGNORE INTO post_likes(post_id, user_id, at) VALUES(?,?,?)",
                      (int(post_id), int(user_id), int(time.time())))
        else:
            c.execute("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?",
                      (int(post_id), int(user_id)))
        c.commit()
        n = c.execute("SELECT COUNT(*) FROM post_likes WHERE post_id = ?", (int(post_id),)).fetchone()[0]
        return n
    finally:
        c.close()


def post_comments_list(post_id, limit=100):
    c = connect()
    try:
        rows = c.execute(
            "SELECT pc.id, pc.post_id, pc.user_id, pc.content, pc.created_at, "
            "u.nickname, u.avatar, u.avatar_decoration, u.is_admin, u.is_super, u.is_owner, u.title "
            "FROM post_comments pc JOIN users u ON u.id = pc.user_id "
            "WHERE pc.post_id = ? ORDER BY pc.id ASC LIMIT ?",
            (int(post_id), int(limit))).fetchall()
    finally:
        c.close()
    return [{
        "id": r["id"], "postId": r["post_id"], "content": r["content"], "createdAt": r["created_at"],
        "author": {"id": r["user_id"], "nickname": r["nickname"], "avatar": r["avatar"],
                   "avatarDecoration": r["avatar_decoration"],
                   "isAdmin": bool(r["is_admin"]), "isSuper": bool(r["is_super"]),
                   "isOwner": bool(r["is_owner"]),
                   "title": r["title"] or ""},
    } for r in rows]


def post_comment_add(user_id, post_id, content):
    content = (content or "").strip()
    if not content:
        raise ValueError("评论不能为空")
    if len(content) > 500:
        raise ValueError("评论最多 500 字")
    now = int(time.time())
    c = connect()
    try:
        if not c.execute("SELECT 1 FROM posts WHERE id = ?", (int(post_id),)).fetchone():
            raise ValueError("帖子不存在")
        cur = c.execute(
            "INSERT INTO post_comments(post_id, user_id, content, created_at) VALUES(?,?,?,?)",
            (int(post_id), int(user_id), content, now))
        c.commit()
        return cur.lastrowid
    finally:
        c.close()


def post_comment_delete(user_id, comment_id):
    c = connect()
    try:
        r = c.execute("SELECT user_id FROM post_comments WHERE id = ?", (int(comment_id),)).fetchone()
        if not r:
            return False
        if int(user_id) != r["user_id"] and int(user_id) not in _admin_ids():
            return False
        c.execute("DELETE FROM post_comments WHERE id = ?", (int(comment_id),))
        c.commit()
        return True
    finally:
        c.close()


def posts_count(author_id=None):
    """帖子总数（分页用）。"""
    conn = connect()
    try:
        if author_id is not None:
            return conn.execute("SELECT COUNT(*) FROM posts WHERE user_id = ?", (int(author_id),)).fetchone()[0]
        return conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0]
    finally:
        conn.close()


def square_users(query="", sort="reg", limit=30, offset=0, listening_only=False):
    """用户广场：公开资料（头像/昵称/个签）+ 轻统计（含听歌时长）；管理员恒置顶。
    内部账户、被禁用用户、以及主动关闭「公开到广场」的用户都不出现。
    listening_only=True 时只返回「正在听歌」（近 LISTENING_WINDOW 秒内有播放）的用户。"""
    order = _SQUARE_SORTS.get(sort, _SQUARE_SORTS["reg"])
    where = "WHERE u.disabled=0 AND u.username != '__internal__' AND u.public_square=1"
    args = []
    if query:
        where += " AND (u.nickname LIKE ? OR u.bio LIKE ?)"
        args = [f"%{query}%"] * 2
    if listening_only:
        # 与 square_stats 同一口径：近 5 分钟内有播放记录即视为「正在听歌」
        where += (" AND EXISTS (SELECT 1 FROM plays pl2 WHERE pl2.user_id=u.id"
                  " AND pl2.played_at >= ?)")
        args = args + [int(time.time()) - LISTENING_WINDOW]
    conn = connect()
    try:
        rows = conn.execute(
            f"""SELECT u.id, u.nickname, u.avatar, u.bio, u.created_at, u.is_admin, u.is_super, u.is_owner,
                   u.avatar_decoration, u.title, u.ip_region, u.is_bot,
                   (SELECT COUNT(*) FROM likes l WHERE l.user_id=u.id) AS likes,
                   (SELECT COUNT(*) FROM playlists p WHERE p.user_id=u.id) AS playlists,
                   (SELECT COUNT(DISTINCT date(pl.played_at,'unixepoch')) FROM plays pl WHERE pl.user_id=u.id) AS days,
                   (SELECT COALESCE(SUM(pl.ms),0) FROM plays pl
                     WHERE pl.user_id=u.id) AS listenMs
            FROM users u {where}
            ORDER BY (u.username = ?) DESC, u.is_owner DESC, u.is_super DESC, u.is_admin DESC, {order}
            LIMIT ? OFFSET ?""",   # Rcst20 恒置顶；其余按角色，再按用户选择的排序
            args + [SQUARE_PINNED_USERNAME, limit, offset],
        ).fetchall()
        total = conn.execute(f"SELECT COUNT(*) FROM users u {where}", args).fetchone()[0]
        users = []
        for r in rows:
            d = dict(r)
            # 与 public_user/public_profile 统一为 camelCase（前端只需认一个字段名）
            d["avatarDecoration"] = d.get("avatar_decoration") or ""
            d["title"] = d.get("title") or ""
            d["isOwner"] = bool(d.get("is_owner"))
            d["ipRegion"] = d.get("ip_region") or ""
            d["isBot"] = bool(d.get("is_bot"))
            users.append(d)
        return {"total": total, "users": users, "stats": square_stats()}
    finally:
        conn.close()


def public_profile(uid):
    """公开用户主页：统计（点赞/歌单/听歌天数/累计时长）+ 最近听过 + 当前在听 + 公开歌单。
    当前在听 = 最近一次播放发生在 5 分钟内。"""
    u = get_user(uid)
    if not u or u.get("disabled") or u["username"] == "__internal__":
        return None
    conn = connect()
    try:
        listen_ms = conn.execute(
            "SELECT COALESCE(SUM(ms),0) d FROM plays WHERE user_id=?", (uid,)
        ).fetchone()["d"]
        cur = conn.execute(
            "SELECT p.ncm_id, p.played_at FROM plays p WHERE p.user_id=?"
            " ORDER BY p.played_at DESC LIMIT 1", (uid,)
        ).fetchone()
        pls = conn.execute(
            "SELECT id, name, cover, source,"
            " (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id=playlists.id) AS track_count"
            " FROM playlists WHERE user_id=? ORDER BY updated_at DESC", (uid,)
        ).fetchall()
    finally:
        conn.close()
    recent_ids = recent_plays(uid, 10)
    now = int(time.time())
    current = None
    if cur and now - int(cur["played_at"]) <= 300:
        m = song_rows_to_meta(songs_by_ids([cur["ncm_id"]]))
        current = (m or [None])[0]
    return {
        "user": {"id": u["id"], "nickname": u["nickname"], "avatar": u["avatar"], "bio": u["bio"],
                 "created_at": u["created_at"], "isAdmin": bool(u.get("is_admin")),
                 "isSuper": bool(u.get("is_super")),
                 "isOwner": bool(u.get("is_owner")),
                 "avatarDecoration": u.get("avatar_decoration") or "",
                 "title": u.get("title") or "",
                 "ipRegion": u.get("ip_region") or "",
                 "isBot": bool(u.get("is_bot")),
                 "public": bool(u.get("public_square", 1))},   # 关闭公开的人不对外暴露关注等社交数据
        "stat": dict(user_stat(uid), listenMs=int(listen_ms)),
        "current": current,
        "recent": song_rows_to_meta(songs_by_ids(recent_ids)),
        "playlists": [dict(p) for p in pls],
    }


def admin_all_sessions(limit=100):
    conn = connect()
    try:
        rows = conn.execute(
            """SELECT s.token_hash, s.user_id, u.username, u.nickname, s.device, s.platform,
                      s.created_at, s.last_seen
               FROM sessions s JOIN users u ON u.id = s.user_id
               ORDER BY s.last_seen DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["id"] = d.pop("token_hash")[:16]
            out.append(d)
        return out
    finally:
        conn.close()


def set_email(uid, email):
    """绑定/换绑邮箱（调用方已完成验证码校验与占用检查）。"""
    conn = connect()
    try:
        conn.execute("UPDATE users SET email=? WHERE id=?", (email, uid))
        conn.commit()
    finally:
        conn.close()


def set_user_region(uid, region):
    """更新用户 IP 属地（展示用；调用方负责节流与解析）。"""
    conn = connect()
    try:
        conn.execute("UPDATE users SET ip_region=? WHERE id=?", (str(region or "")[:32], int(uid)))
        conn.commit()
    finally:
        conn.close()


def update_profile(uid, fields):
    allowed = {"nickname", "bio", "avatar"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            vals.append(str(v)[:300])
    if not sets:
        return
    vals.append(uid)
    conn = connect()
    try:
        conn.execute(f"UPDATE users SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    finally:
        conn.close()


def set_password(uid, new_pw):
    """直接设置新密码（调用方须已完成原密码或邮箱验证码校验）。

    与 change_password 分开：密码找回没有原密码可校验，但仍要走同一套
    pbkdf2 加盐存储，避免两条路径出现不同的哈希参数。
    """
    salt = secrets.token_hex(8)
    conn = connect()
    try:
        conn.execute(
            "UPDATE users SET pass_hash=?, salt=? WHERE id=?",
            (hash_password(new_pw, salt), salt, uid),
        )
        conn.execute('DELETE FROM login_2fa WHERE uid=?', (uid,))
        conn.execute("UPDATE account_2fa SET pending='',pending_sid='',pending_until=0 WHERE uid=?", (uid,))
        conn.commit()
    finally:
        conn.close()


def change_password(uid, old_pw, new_pw):
    u = get_user(uid)
    if not u or hash_password(old_pw, u["salt"]) != u["pass_hash"]:
        return False
    set_password(uid, new_pw)
    return True


# ---------- 点赞 / 收藏 / 播放 ----------

def _toggle(table, uid, ncm_id):
    conn = connect()
    now = int(time.time())
    try:
        cur = conn.execute(f"DELETE FROM {table} WHERE user_id=? AND ncm_id=?", (uid, ncm_id))
        liked = cur.rowcount == 0
        if liked:
            conn.execute(f"INSERT OR IGNORE INTO {table}(user_id,ncm_id,created_at) VALUES(?,?,?)", (uid, ncm_id, now))
        conn.commit()
        return liked
    finally:
        conn.close()


def toggle_like(uid, ncm_id):
    return _toggle("likes", uid, ncm_id)


def toggle_fav(uid, ncm_id):
    return _toggle("favs", uid, ncm_id)


def is_liked(uid, ncm_ids):
    conn = connect()
    try:
        marks = ",".join("?" * len(ncm_ids))
        rows = conn.execute(
            f"SELECT ncm_id FROM likes WHERE user_id=? AND ncm_id IN ({marks})", [uid] + list(ncm_ids)
        ).fetchall()
        return {r["ncm_id"] for r in rows}
    finally:
        conn.close()


def like_ids(uid, table="likes", limit=500):
    conn = connect()
    try:
        rows = conn.execute(
            f"SELECT ncm_id FROM {table} WHERE user_id=? ORDER BY created_at DESC LIMIT ?", (uid, limit)
        ).fetchall()
        return [r["ncm_id"] for r in rows]
    finally:
        conn.close()


def like_counts(ncm_ids):
    if not ncm_ids:
        return {}
    conn = connect()
    try:
        out = {int(i): 0 for i in ncm_ids}
        marks = ",".join("?" * len(ncm_ids))
        rows = conn.execute(
            f"SELECT ncm_id, COUNT(*) AS c FROM likes WHERE ncm_id IN ({marks}) GROUP BY ncm_id",
            list(ncm_ids),
        ).fetchall()
        for r in rows:
            out[r["ncm_id"]] = r["c"]
        return out
    finally:
        conn.close()


def user_stat(uid):
    conn = connect()
    try:
        likes = conn.execute("SELECT COUNT(*) c FROM likes WHERE user_id=?", (uid,)).fetchone()["c"]
        favs = conn.execute("SELECT COUNT(*) c FROM favs WHERE user_id=?", (uid,)).fetchone()["c"]
        pls = conn.execute("SELECT COUNT(*) c FROM playlists WHERE user_id=?", (uid,)).fetchone()["c"]
        days = conn.execute(
            "SELECT COUNT(DISTINCT date(played_at,'unixepoch')) c FROM plays WHERE user_id=?", (uid,)
        ).fetchone()["c"]
        # 累计听歌时长（毫秒）：与广场/公开主页同一口径，挂件解锁门槛也用它
        listen_ms = conn.execute(
            "SELECT COALESCE(SUM(ms),0) d FROM plays WHERE user_id=?", (uid,)
        ).fetchone()["d"]
        return {"likes": likes, "favs": favs, "playlists": pls, "playDays": days,
                "listenMs": int(listen_ms)}
    finally:
        conn.close()


def record_play(uid, ncm_id):
    """记一次"开始播放"。ms 由 add_play_ms 在播放过程中累加。

    注意：**不再删除同曲旧记录**——旧实现只保留每首歌最后一条，导致"同一首听 100 遍"
    与"听 1 遍"记的量完全相同（虚低）。历史列表按 GROUP BY 取最新时间，不会重复展示。
    """
    conn = connect()
    try:
        conn.execute("INSERT INTO plays(user_id,ncm_id,played_at,ms) VALUES(?,?,?,0)",
                     (uid, ncm_id, int(time.time())))
        conn.commit()
    finally:
        conn.close()


# 单次上报的上限：前端每 30s 冲一次，正常远小于此；异常值（时钟跳变/双重上报）直接截断
PLAY_MS_MAX_PER_CALL = 15 * 60 * 1000


def add_play_ms(uid, ncm_id, ms):
    """把一段**真实收听毫秒**记到该用户最近一次这首歌的播放记录上。

    返回实际记入的毫秒数（0 表示没有可归属的记录或参数无效）。
    """
    try:
        add = int(ms)
    except (TypeError, ValueError):
        return 0
    if add <= 0:
        return 0
    add = min(add, PLAY_MS_MAX_PER_CALL)
    conn = connect()
    try:
        cur = conn.execute(
            "UPDATE plays SET ms = COALESCE(ms,0) + ? WHERE rowid = ("
            " SELECT rowid FROM plays WHERE user_id=? AND ncm_id=?"
            " ORDER BY played_at DESC, rowid DESC LIMIT 1)",
            (add, int(uid), int(ncm_id)))
        conn.commit()
        return add if cur.rowcount else 0
    finally:
        conn.close()


def play_sync_candidate(uid, ncm_id, min_ms=60_000):
    """原子地取一次「满 60 秒且尚未同步网易云」的播放，并标记为已领取。

    返回 ``{"rowid": ..., "ms": ...}``；没有可同步记录时返回 ``None``。
    领取后若网络上报失败，调用方必须用 :func:`reset_play_sync` 放回重试。
    """
    conn = connect()
    try:
        row = conn.execute(
            "SELECT rowid, ms, COALESCE(ncm_synced,0) synced FROM plays"
            " WHERE user_id=? AND ncm_id=? ORDER BY played_at DESC, rowid DESC LIMIT 1",
            (int(uid), int(ncm_id))).fetchone()
        if not row or int(row["ms"] or 0) < int(min_ms) or row["synced"]:
            return None
        cur = conn.execute(
            "UPDATE plays SET ncm_synced=1 WHERE rowid=? AND COALESCE(ncm_synced,0)=0",
            (int(row["rowid"]),))
        conn.commit()
        if not cur.rowcount:
            return None
        return {"rowid": int(row["rowid"]), "ms": int(row["ms"] or 0)}
    finally:
        conn.close()


def reset_play_sync(rowid):
    """网易云上报失败时清除领取标记，下个 30 秒增量会再次尝试。"""
    conn = connect()
    try:
        conn.execute("UPDATE plays SET ncm_synced=0 WHERE rowid=?", (int(rowid),))
        conn.commit()
    finally:
        conn.close()


def recent_plays(uid, limit=100):
    """每首歌只保留最近一次，按时间倒序。"""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT p.ncm_id, MAX(p.played_at) t FROM plays p WHERE p.user_id=?"
            " GROUP BY p.ncm_id ORDER BY t DESC LIMIT ?",
            (uid, limit),
        ).fetchall()
        return [r["ncm_id"] for r in rows]
    finally:
        conn.close()


# ---------- 歌单 ----------

def create_playlist(uid, name, description="", source="local", ncm_pl_id=0, cover="", ncm_order=0):
    conn = connect()
    now = int(time.time())
    try:
        cur = conn.execute(
            "INSERT INTO playlists(user_id,name,description,source,ncm_pl_id,cover,ncm_order,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (uid, str(name)[:60], str(description or "")[:300], source, int(ncm_pl_id), str(cover or "")[:500],
             int(ncm_order or 0), now, now),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def find_ncm_playlist(uid, ncm_pl_id):
    conn = connect()
    try:
        r = conn.execute(
            "SELECT id FROM playlists WHERE user_id=? AND ncm_pl_id=? AND source='ncm'", (uid, int(ncm_pl_id))
        ).fetchone()
        return r["id"] if r else None
    finally:
        conn.close()


def set_playlist_meta(pid, name=None, cover=None, ncm_order=None):
    conn = connect()
    try:
        sets, vals = [], []
        if name:
            sets.append("name=?"); vals.append(str(name)[:60])
        if cover:
            sets.append("cover=?"); vals.append(str(cover or "")[:500])
        if ncm_order is not None:
            sets.append("ncm_order=?"); vals.append(int(ncm_order))
        if not sets:
            return
        sets.append("updated_at=?"); vals.extend([int(time.time()), pid])
        conn.execute(f"UPDATE playlists SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    finally:
        conn.close()


def set_ncm_playlist_orders(uid, ncm_ids):
    """按 /user/playlist 返回顺序批量写入 ncm_order（用于同步与存量校准）。

    上游已不存在、但仍保留为本地快照的 NCM 歌单会统一排到当前上游列表之后，
    避免旧顺序插在网易云 App 当前展示的歌单中间。
    """
    conn = connect()
    try:
        ids = [int(i) for i in ncm_ids]
        rows = conn.execute(
            "SELECT id, ncm_pl_id FROM playlists WHERE user_id=? AND source='ncm'", (int(uid),)
        ).fetchall()
        by_ncm = {int(r["ncm_pl_id"]): int(r["id"]) for r in rows if r["ncm_pl_id"]}
        for i, ncm_id in enumerate(ids):
            if ncm_id in by_ncm:
                conn.execute("UPDATE playlists SET ncm_order=? WHERE id=?", (i, by_ncm[ncm_id]))
        missing = sorted(
            (row for row in rows if int(row["ncm_pl_id"] or 0) not in set(ids)),
            key=lambda r: int(r["id"]),
        )
        for i, row in enumerate(missing):
            conn.execute("UPDATE playlists SET ncm_order=? WHERE id=?", (len(ids) + i, row["id"]))
        conn.commit()
    finally:
        conn.close()


def replace_playlist_tracks(pid, ncm_ids):
    """整表替换（NCM 同步用），单事务。"""
    conn = connect()
    try:
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
        conn.executemany(
            "INSERT OR IGNORE INTO playlist_tracks(playlist_id,ncm_id) VALUES(?,?)",
            [(pid, int(i)) for i in ncm_ids],
        )
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (int(time.time()), pid))
        conn.commit()
    finally:
        conn.close()


# ---------- 网易云账号绑定 ----------

def save_binding(uid, cookie, ncm_uid=0, nickname="", avatar=""):
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO ncm_bindings(user_id,ncm_uid,ncm_nickname,ncm_avatar,cookie,bound_at)"
            " VALUES(?,?,?,?,?,?)"
            " ON CONFLICT(user_id) DO UPDATE SET ncm_uid=excluded.ncm_uid, ncm_nickname=excluded.ncm_nickname,"
            " ncm_avatar=excluded.ncm_avatar, cookie=excluded.cookie, bound_at=excluded.bound_at, stale=0,"
            " ncm_liked_pl_id=CASE WHEN ncm_uid!=excluded.ncm_uid THEN 0 ELSE ncm_liked_pl_id END,"
            " last_sync=CASE WHEN ncm_uid!=excluded.ncm_uid THEN 0 ELSE last_sync END,"
            " last_sync_count=CASE WHEN ncm_uid!=excluded.ncm_uid THEN 0 ELSE last_sync_count END",
            (uid, int(ncm_uid or 0), str(nickname or "")[:100], str(avatar or "")[:500], cookie, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()


def get_binding(uid):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM ncm_bindings WHERE user_id=?", (uid,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def delete_binding(uid):
    conn = connect()
    try:
        conn.execute("DELETE FROM ncm_bindings WHERE user_id=?", (uid,))
        conn.commit()
    finally:
        conn.close()


def mark_binding_stale(uid, stale=1):
    conn = connect()
    try:
        conn.execute("UPDATE ncm_bindings SET stale=? WHERE user_id=?", (stale, uid))
        conn.commit()
    finally:
        conn.close()


def set_binding_liked_pl(uid, ncm_pl_id):
    conn = connect()
    try:
        conn.execute("UPDATE ncm_bindings SET ncm_liked_pl_id=? WHERE user_id=?", (int(ncm_pl_id), uid))
        conn.commit()
    finally:
        conn.close()


def update_binding_sync(uid, count):
    conn = connect()
    try:
        conn.execute(
            "UPDATE ncm_bindings SET last_sync=?, last_sync_count=?, stale=0 WHERE user_id=?",
            (int(time.time()), int(count), uid),
        )
        conn.commit()
    finally:
        conn.close()


def get_playlist(pid):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def playlists_of(uid):
    """当前用户歌单。

    排序与「歌单库」两段的展示口径一致：
      1. source='ncm'：按网易云 /user/playlist 的返回顺序（ncm_order），
         与网易云 App「我的 → 音乐」保持一致；
      2. 本地歌单：创建时间倒序。
    """
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id=p.id) AS track_count"
            " FROM playlists p WHERE p.user_id=?",
            (uid,),
        ).fetchall()
        out = [dict(r) for r in rows]
        for d in out:
            d["ncmOrder"] = int(d.get("ncm_order") or 0)
        ncm = sorted((d for d in out if d.get("source") == "ncm"),
                     key=lambda d: (d["ncmOrder"], d["id"]))
        local = sorted((d for d in out if d.get("source") != "ncm"),
                       key=lambda d: (-int(d["created_at"] or 0), -d["id"]))
        return ncm + local
    finally:
        conn.close()


def update_playlist(pid, fields):
    allowed = {"name", "description"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed and v:
            sets.append(f"{k}=?")
            vals.append(str(v)[:300])
    if not sets:
        return
    sets.append("updated_at=?")
    vals.extend([int(time.time()), pid])
    conn = connect()
    try:
        conn.execute(f"UPDATE playlists SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    finally:
        conn.close()


def delete_playlist(pid):
    conn = connect()
    try:
        conn.execute("DELETE FROM playlists WHERE id=?", (pid,))
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
        conn.commit()
    finally:
        conn.close()


def playlist_add_tracks(pid, ncm_ids):
    conn = connect()
    try:
        conn.executemany(
            "INSERT OR IGNORE INTO playlist_tracks(playlist_id,ncm_id) VALUES(?,?)",
            [(pid, int(i)) for i in ncm_ids],
        )
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (int(time.time()), pid))
        conn.commit()
    finally:
        conn.close()


def playlist_del_tracks(pid, ncm_ids):
    conn = connect()
    try:
        marks = ",".join("?" * len(ncm_ids))
        conn.execute(f"DELETE FROM playlist_tracks WHERE playlist_id=? AND ncm_id IN ({marks})", [pid] + list(ncm_ids))
        conn.execute("UPDATE playlists SET updated_at=? WHERE id=?", (int(time.time()), pid))
        conn.commit()
    finally:
        conn.close()


def playlist_track_ids(pid):
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT ncm_id FROM playlist_tracks WHERE playlist_id=? ORDER BY seq", (pid,)
        ).fetchall()
        return [r["ncm_id"] for r in rows]
    finally:
        conn.close()


def playlists_containing(uid, ncm_id):
    """该用户哪些歌单包含此歌（收藏状态用）。"""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT p.id FROM playlists p JOIN playlist_tracks t ON t.playlist_id=p.id"
            " WHERE p.user_id=? AND t.ncm_id=?",
            (uid, ncm_id),
        ).fetchall()
        return [r["id"] for r in rows]
    finally:
        conn.close()


# ---------- 命中缓存（歌词/详情/评论数/每日推荐） ----------

def cache_get(key):
    conn = connect()
    try:
        r = conn.execute("SELECT v FROM cache WHERE k=? AND expires>?", (key, int(time.time()))).fetchone()
        return r["v"] if r else None
    finally:
        conn.close()


def cache_delete(key):
    conn = connect()
    try:
        conn.execute("DELETE FROM cache WHERE k=?", (key,))
        conn.commit()
    finally:
        conn.close()


def cache_purge_expired():
    """清理过期缓存，返回删除行数。缓存表不会自己缩，长期不清理会白占几十 MB。"""
    conn = connect()
    try:
        cur = conn.execute("DELETE FROM cache WHERE expires<=?", (int(time.time()),))
        conn.commit()
        return cur.rowcount or 0
    finally:
        conn.close()


def cache_set(key, value_json, ttl):
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO cache(k,v,expires) VALUES(?,?,?)"
            " ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires=excluded.expires",
            (key, value_json, int(time.time()) + ttl),
        )
        conn.commit()
    finally:
        conn.close()


# ---------- 推荐（猜你喜欢：基于点赞歌手） ----------

def top_liked_artists(uid, n=5):
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT s.artists FROM likes l JOIN songs s ON s.ncm_id=l.ncm_id"
            " WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 200",
            (uid,),
        ).fetchall()
        seen = {}
        for r in rows:
            for a in str(r["artists"] or "").split("/"):
                a = a.strip()
                if a:
                    seen[a] = seen.get(a, 0) + 1
        return [a for a, _ in sorted(seen.items(), key=lambda x: -x[1])[:n]]
    finally:
        conn.close()

# ---------- CurrentStation 通行证（v1.28.17） ----------
# 设计口径：
#   · 账号本体仍然只有 users 一张表（通行证 = 同一批账号 + 授权层），不另起一套用户；
#   · 令牌/授权码只存 sha256，明文只在签发那一刻返回给调用方；
#   · 授权（passport_grants）绑定到发起授权的浏览器会话 sid，从而支持「单点登出」：
#     在任意产品里退出登录 = 撤销该会话 → 该会话发出的所有通行证令牌立即失效。

PASSPORT_UID_PREFIX = "cs_"


def passport_uid(uid):
    """用户的通行证公开标识（sub，形如 cs_1a2b3c4d5e6f）。历史用户首次访问时惰性生成。"""
    conn = connect()
    try:
        r = conn.execute("SELECT passport_uid FROM users WHERE id=?", (uid,)).fetchone()
        if r and r["passport_uid"]:
            return r["passport_uid"]
        for _ in range(5):                      # 撞了就重试（32^6 ≈ 10 亿，实际不会撞）
            v = PASSPORT_UID_PREFIX + secrets.token_hex(6)
            row = conn.execute("SELECT 1 FROM users WHERE passport_uid=?", (v,)).fetchone()
            if not row:
                conn.execute("UPDATE users SET passport_uid=? WHERE id=?", (v, uid))
                conn.commit()
                return v
        raise RuntimeError("无法分配通行证标识")
    finally:
        conn.close()


def passport_app_create(key, name, secret_hash, redirects, scopes, owner_uid=0,
                        homepage="", logo="", first_party=0):
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO passport_apps(key,name,secret_hash,redirects,scopes,owner_uid,"
            "homepage,logo,first_party,disabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?)",
            (key, name, secret_hash, json.dumps(redirects, ensure_ascii=False),
             scopes, owner_uid, homepage, logo, 1 if first_party else 0, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()


def passport_app_get(key):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM passport_apps WHERE key=?", (key,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def passport_app_list():
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM passport_apps ORDER BY first_party DESC, created_at ASC")]
    finally:
        conn.close()


def passport_app_update(key, **fields):
    """只允许改这几项（client_id / secret 不可变）。"""
    allow = ("name", "redirects", "scopes", "homepage", "logo", "disabled", "first_party",
             "secret_hash")
    sets, vals = [], []
    for k, v in fields.items():
        if k not in allow:
            continue
        if k == "redirects":
            v = json.dumps(v or [], ensure_ascii=False)
        if k in ("disabled", "first_party"):
            v = 1 if v else 0
        sets.append(f"{k}=?")
        vals.append(v)
    if not sets:
        return False
    conn = connect()
    try:
        cur = conn.execute(f"UPDATE passport_apps SET {','.join(sets)} WHERE key=?", (*vals, key))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def passport_app_delete(key):
    """停用 + 撤销该应用全部授权（不物理删行，审计与统计还要用）。"""
    conn = connect()
    try:
        conn.execute("UPDATE passport_apps SET disabled=1 WHERE key=?", (key,))
        conn.execute("UPDATE passport_grants SET revoked=1 WHERE app_key=?", (key,))
        conn.commit()
    finally:
        conn.close()


def passport_code_put(code_hash, app_key, uid, redirect_uri, scope, challenge, method, sid, ttl):
    now = int(time.time())
    conn = connect()
    try:
        conn.execute("DELETE FROM passport_codes WHERE expires<?", (now,))     # 顺手清理过期
        conn.execute(
            "INSERT INTO passport_codes(code_hash,app_key,uid,redirect_uri,scope,challenge,"
            "method,sid,created_at,expires) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (code_hash, app_key, uid, redirect_uri, scope, challenge, method, sid, now, now + ttl),
        )
        conn.commit()
    finally:
        conn.close()


def passport_code_take(code_hash):
    """取用授权码：**原子失效**（取到即删），天然防重放。"""
    now = int(time.time())
    conn = connect()
    try:
        r = conn.execute(
            "SELECT * FROM passport_codes WHERE code_hash=? AND expires>=?", (code_hash, now)
        ).fetchone()
        conn.execute("DELETE FROM passport_codes WHERE code_hash=?", (code_hash,))
        conn.commit()
        return dict(r) if r else None
    finally:
        conn.close()


def passport_grant_create(gid, app_key, uid, scope, access_hash, refresh_hash,
                          access_expires, refresh_expires, sid="", device="", platform=""):
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO passport_grants(id,app_key,uid,scope,access_hash,refresh_hash,"
            "access_expires,refresh_expires,created_at,last_used,revoked,sid,device,platform)"
            " VALUES(?,?,?,?,?,?,?,?,?,0,0,?,?,?)",
            (gid, app_key, uid, scope, access_hash, refresh_hash, access_expires,
             refresh_expires, int(time.time()), sid, str(device or "")[:120], str(platform or "")[:20]),
        )
        conn.commit()
    finally:
        conn.close()


def passport_grant_by_access(access_hash):
    conn = connect()
    try:
        r = conn.execute(
            "SELECT * FROM passport_grants WHERE access_hash=? AND revoked=0", (access_hash,)
        ).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def passport_grant_by_refresh(refresh_hash):
    conn = connect()
    try:
        r = conn.execute(
            "SELECT * FROM passport_grants WHERE refresh_hash=? AND revoked=0", (refresh_hash,)
        ).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def passport_grant_rotate(gid, access_hash, refresh_hash, access_expires, refresh_expires):
    conn = connect()
    try:
        conn.execute(
            "UPDATE passport_grants SET access_hash=?,refresh_hash=?,access_expires=?,"
            "refresh_expires=? WHERE id=? AND revoked=0",
            (access_hash, refresh_hash, access_expires, refresh_expires, gid),
        )
        conn.commit()
    finally:
        conn.close()


def passport_grant_touch(gid):
    """刷新 last_used（60s 节流，避免每个请求都写库）。"""
    now = int(time.time())
    conn = connect()
    try:
        conn.execute(
            "UPDATE passport_grants SET last_used=? WHERE id=? AND last_used<?",
            (now, gid, now - 60),
        )
        conn.commit()
    finally:
        conn.close()


def passport_grant_get(gid):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM passport_grants WHERE id=?", (gid,)).fetchone()
        return dict(r) if r else None
    finally:
        conn.close()


def passport_grant_revoke(uid=None, gid=None, app_key=None, sid=None):
    """按 用户+授权id / 应用 / 会话 撤销授权，返回撤销条数。"""
    where, vals = ["revoked=0"], []
    if uid is not None:
        where.append("uid=?")
        vals.append(uid)
    if gid is not None:
        where.append("id=?")
        vals.append(gid)
    if app_key is not None:
        where.append("app_key=?")
        vals.append(app_key)
    if sid is not None:
        where.append("sid=?")
        vals.append(sid)
    conn = connect()
    try:
        cur = conn.execute(f"UPDATE passport_grants SET revoked=1 WHERE {' AND '.join(where)}", tuple(vals))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def passport_grant_revoke_sid(sid):
    """某会话被登出时，撤销它发出的全部通行证授权（单点登出）。"""
    if not sid:
        return 0
    return passport_grant_revoke(sid=sid)


def passport_grant_list_user(uid):
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT g.*, a.name AS app_name, a.homepage AS app_homepage, a.first_party AS app_first_party"
            " FROM passport_grants g LEFT JOIN passport_apps a ON a.key=g.app_key"
            " WHERE g.uid=? AND g.revoked=0 ORDER BY g.created_at DESC", (uid,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def passport_grant_list_app(app_key):
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT g.id, g.uid, g.scope, g.created_at, g.last_used, u.username, u.nickname"
            " FROM passport_grants g LEFT JOIN users u ON u.id=g.uid"
            " WHERE g.app_key=? AND g.revoked=0 ORDER BY g.created_at DESC", (app_key,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def passport_event(kind, app_key="", uid=0, ip="", ua="", detail=""):
    """审计：授权/令牌/撤销都留痕（排查线上问题与风控用）。失败不影响主流程。"""
    try:
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO passport_events(ts,app_key,uid,kind,ip,ua,detail) VALUES(?,?,?,?,?,?,?)",
                (int(time.time()), app_key or "", int(uid or 0), kind, ip or "", (ua or "")[:200], detail or ""),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        log.warning("passport_event 写入失败 kind=%s", kind, exc_info=True)


def passport_events(limit=100, uid=0, app_key=""):
    conn = connect()
    try:
        where, vals = [], []
        if uid:
            where.append("uid=?")
            vals.append(uid)
        if app_key:
            where.append("app_key=?")
            vals.append(app_key)
        sql = "SELECT * FROM passport_events" + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY id DESC LIMIT ?"
        vals.append(max(1, min(int(limit or 100), 500)))
        return [dict(r) for r in conn.execute(sql, tuple(vals))]
    finally:
        conn.close()


# ---------- 弹窗公告（v1.28.22） ----------

def _ann_row(r):
    d = dict(r)
    d["createdAt"] = r["created_at"]
    d["updatedAt"] = r["updated_at"]
    return d


def ann_list(include_removed=False, author_uid=None, limit=50):
    """公告列表：置顶在前，其余按发布时间倒序。

    include_removed=True 供管理后台使用（能看到已移除的）；author_uid 用于
    「只看我发布的」（管理后台里普通管理员用不用它由路由决定，这里只提供能力）。
    """
    conn = connect()
    try:
        where, vals = [], []
        if not include_removed:
            where.append("a.removed=0")
        if author_uid is not None:
            where.append("a.user_id=?")
            vals.append(author_uid)
        sql = ("SELECT a.*, u.username AS author_username, u.nickname AS author_nickname"
               " FROM announcements a LEFT JOIN users u ON u.id=a.user_id")
        if where:
            sql += " WHERE " + " AND ".join(where)
        # id 兜底：同一秒内发布的两条公告 created_at 相同，没有它排序不稳定
        sql += " ORDER BY a.removed ASC, a.pinned DESC, a.created_at DESC, a.id DESC LIMIT ?"
        vals.append(max(1, min(int(limit or 50), 200)))
        return [_ann_row(r) for r in conn.execute(sql, tuple(vals))]
    finally:
        conn.close()


def ann_get(aid):
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM announcements WHERE id=?", (int(aid),)).fetchone()
        return _ann_row(r) if r else None
    finally:
        conn.close()


def ann_create(user_id, title, body, link="", pinned=0):
    now = int(time.time())
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO announcements(user_id,title,body,link,pinned,removed,created_at,updated_at)"
            " VALUES(?,?,?,?,?,0,?,?)",
            (int(user_id), str(title)[:200], str(body or ""),
             str(link or "")[:500], 1 if pinned else 0, now, now),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def ann_update(aid, **fields):
    allow = ("title", "body", "link", "pinned", "removed")
    sets, vals = [], []
    for k, v in fields.items():
        if k not in allow:
            continue
        if k in ("pinned", "removed"):
            v = 1 if v else 0
        if k == "title":
            v = str(v)[:200]
        if k == "link":
            v = str(v or "")[:500]
        sets.append(f"{k}=?")
        vals.append(v)
    if not sets:
        return False
    sets.append("updated_at=?")
    vals.append(int(time.time()))
    conn = connect()
    try:
        cur = conn.execute(f"UPDATE announcements SET {','.join(sets)} WHERE id=?", (*vals, int(aid)))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
