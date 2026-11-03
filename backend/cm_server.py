"""CurrentMusic 后端 HTTP 服务：自建账号/点赞/收藏/歌单 + NCM 音源代理。

纯标准库（http.server + sqlite3），监听 127.0.0.1:3010，
公网经 nginx `location /cm/` 反代（前缀被剥掉，本服务看到的是 /health、/auth/... 等）。
"""
import json
import logging
import hashlib
import os
import re
import secrets
import sys
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cm_cast
import cm_2fa
import cm_passkeys
import cm_db
import cm_decor
import cm_lddc
import cm_mail
import cm_ncm
import cm_binding_import
import cm_ncm_gateway
import cm_net
import cm_ncm_registry
import cm_passport
import cm_rooms
import cm_sms
import cm_stream
import cm_share
import cm_ai
import cm_chat
import cm_region
import cm_lines

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cm")

HOST = "127.0.0.1"
PORT = int(os.environ.get("CM_PORT", "3010"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CM_DATA_DIR", os.path.join(ROOT, "data"))
DEFAULT_HOST = os.environ.get("CM_DEFAULT_HOST", "localhost")
AVATAR_DIR = os.environ.get("CM_AVATAR_DIR", os.path.join(DATA_DIR, "avatars"))
RELEASES_DIR = os.environ.get("CM_RELEASES", os.path.join(DATA_DIR, "releases"))
# CurrentMusicX（第三方 Kotlin 原生客户端）的安装包镜像目录。
# 由 tools/sync-cmx-releases.py 定时从 GitHub Releases 同步，对外前缀 /cm/x/**。
X_RELEASES_DIR = os.environ.get("CM_X_RELEASES", os.path.join(DATA_DIR, "releases-x"))
MAX_BODY = 2 * 1024 * 1024
# dolby/vivid：音效变体（API 文档 /song/url/v1）。实测本账号 dolby 会被上游
# 降级为 jyeffect（需设备支持），vivid 偶发返回错误页——由 url_is_audio 拦截后走阶梯降档。
VALID_LEVELS = ("standard", "exhigh", "lossless", "hires", "sky", "jyeffect", "jymaster", "dolby", "vivid")

# 私人漫游模式/场景（与 CurrentMusicX v1.1.18 的目录保持一致）。
# 上游 /personal/fm/mode 只负责返回歌曲；模式目录由客户端侧固定，场景可用随账号变化。
ROAMING_MODES = (
    {"code": "DEFAULT", "title": "默认模式", "subtitle": "沿着目前喜好继续聆听"},
    {"code": "FAMILIAR", "title": "熟悉模式", "subtitle": "喜欢过的歌曲与相似推荐"},
    {"code": "EXPLORE", "title": "探索模式", "subtitle": "偏好曲风与潜力好歌"},
    {"code": "PUZZLE_MODE_RCMD", "title": "拼图模式", "subtitle": "边听歌边拼歌曲封面"},
)
ROAMING_SCENES = (
    {"code": "NIGHT_EMO", "title": "伤感"},
    {"code": "EXERCISE", "title": "运动"},
    {"code": "SLEEP_HELP", "title": "助眠"},
    {"code": "RELAX", "title": "放松"},
    {"code": "FOCUS", "title": "专注"},
    {"code": "COMMUTE", "title": "出行"},
)

# ---------- 简单限速：每 IP 每分钟 300 次（nginx 层另有 120/min 域名级限制） ----------
_rl_lock = threading.Lock()
_rl_buckets = defaultdict(deque)
_RL_LIMIT, _RL_WINDOW = 300, 60.0
# 登录/注册/验证码单独一档：30 次/分钟/IP。全站 300/min 对撞库太宽松；
# 不能设更低是因为大量用户可能在同一个 NAT 出口后面。
_auth_lock = threading.Lock()
_auth_buckets = defaultdict(deque)
_AUTH_LIMIT, _AUTH_WINDOW = 30, 60.0
_AUTH_PATHS = {
    "/auth/passkeys/register/options", "/auth/passkeys/register/verify",
    "/auth/passkeys/login/options", "/auth/passkeys/login/verify", "/auth/passkeys/delete",
    "/auth/login", "/auth/login/email", "/auth/login/email/code",
    "/auth/email/code", "/auth/phone/code", "/auth/register", "/auth/internal",
    # 密码找回/修改：发码与重置同样按认证入口限速，避免被当作撞库或邮件轰炸通道
    "/auth/password/code", "/auth/password/reset",
    "/auth/security-question", "/auth/security-question/login",
    "/auth/2fa/login", "/auth/2fa/setup", "/auth/2fa/enable", "/auth/2fa/disable",
    "/profile/password", "/profile/password/code",
    "/ncmbind/import",
}

# ---------- 网易云扫码绑定会话：key → (user_id, 创建时间) ----------
_qr_lock = threading.Lock()
_qr_sessions = {}


def _avatar_shrink(data, kind, max_px=256):
    """头像压缩：等比缩到 max_px、JPEG q85（PNG 保留透明）。

    流量账里头像是第二大消耗（单文件可达数百 KB 且被高频重复拉取）。
    PIL 与分享图一样是可选依赖：没装时原样返回，只损失压缩、不影响功能。
    """
    try:
        from io import BytesIO
        from PIL import Image
        import cm_image
    except Exception:
        return data
    try:
        im = cm_image.open_image(data, formats=("JPEG", "PNG", "WEBP"))
        if getattr(im, "n_frames", 1) > 1:      # 动图：取第一帧
            im.seek(0)
        if im.mode in ("RGBA", "LA"):
            has_alpha = im.convert("RGBA").getextrema()[3][0] < 255
        elif im.mode == "P":
            has_alpha = "transparency" in im.info
        else:
            has_alpha = False
        im = im.convert("RGBA") if has_alpha else im.convert("RGB")
        w, h = im.size
        scale = max_px / max(w, h)
        if scale < 1:
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        out = BytesIO()
        if has_alpha and kind == "png":
            im.save(out, "PNG", optimize=True)
        else:
            im.convert("RGB").save(out, "JPEG", quality=85, optimize=True, progressive=True)
        blob = out.getvalue()
        return blob if 0 < len(blob) < len(data) else data
    except ValueError:
        raise
    except Exception:
        return data


# ---------- 网易云歌单同步 ----------

def _sync_one_playlist(uid, cookie, pl):
    """同步单个 NCM 歌单：/playlist/detail 一次取全量 tracks → 整表替换。
    上游拉取为空且本地已有曲目时跳过替换，避免抖动清空。

    ``pl.order`` 来自 /user/playlist 的返回顺序；即使 4 个歌单并发导入、完成
    顺序被打乱，也必须把这份顺序写进本地，供 /playlists 按网易云 App 展示。
    """
    order = int(pl.get("order") or 0)
    full = cm_ncm.playlist_full(cookie, pl["ncm_pl_id"])
    existed = bool(cm_db.find_ncm_playlist(uid, pl["ncm_pl_id"]))
    name = full["name"] or pl["name"]
    cover = full["cover"] or pl["cover"]
    if existed:
        pid = cm_db.find_ncm_playlist(uid, pl["ncm_pl_id"])
        cm_db.set_playlist_meta(pid, name=name, cover=cover, ncm_order=order)
    else:
        pid = cm_db.create_playlist(uid, name, "来自网易云音乐", source="ncm",
                                    ncm_pl_id=pl["ncm_pl_id"], cover=cover,
                                    ncm_order=order)
    cm_db.upsert_songs_many(full["songs"])
    track_count = len(full["songs"])
    if track_count or not existed:
        cm_db.replace_playlist_tracks(pid, [s["ncm_id"] for s in full["songs"]])
    else:
        track_count = len(cm_db.playlist_track_ids(pid))
    return {"id": pid, "name": name, "cover": cover, "track_count": track_count,
            "ncmOrder": order}


def sync_ncm_playlists(uid, budget=60.0):
    """把绑定账号的全部 NCM 歌单导入本地（source='ncm'，整表替换曲目）。
    4 并发 + 全局时间预算：超预算的未完成歌单标记 pending，再次同步可续传。"""
    b = cm_db.get_binding(uid)
    if not b:
        raise ApiError(400, "尚未绑定网易云账号")
    cookie = b["cookie"]
    acc = cm_ncm.user_account(cookie)
    if not acc.get("uid") or acc.get("code") not in (200, None):
        cm_db.mark_binding_stale(uid, 1)
        raise ApiError(502, "网易云登录已失效，请重新扫码绑定")
    cm_db.save_binding(uid, cookie, acc["uid"], acc["nickname"], acc["avatar"])
    pls = cm_ncm.user_playlists(cookie, acc["uid"])[:50]
    if pls:
        # user/playlist 首项恒为该账号的「我喜欢的音乐」
        cm_db.set_binding_liked_pl(uid, pls[0]["ncm_pl_id"])
    imported, failed, total = 0, 0, 0
    out_pls = []
    deadline = time.time() + budget
    ex = ThreadPoolExecutor(max_workers=4)
    try:
        futs = {}
        for i, pl in enumerate(pls):
            pl.setdefault("order", i)       # 兼容外部直接调用 / 旧测试桩
            futs[ex.submit(_sync_one_playlist, uid, cookie, pl)] = pl
        for fut, pl in futs.items():
            left = deadline - time.time()
            try:
                r = fut.result(timeout=max(left, 0.1))
                imported += 1
                total += r["track_count"]
                out_pls.append(r)
            except FuturesTimeout:
                log.info("歌单同步达到时间预算 uid=%s，其余下次续传", uid)
                break
            except Exception as e:  # noqa: BLE001 单歌单失败不阻断整体
                log.warning("歌单同步失败 uid=%s pl=%s: %s", uid, pl.get("name"), e)
                failed += 1
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    # 即使并发完成顺序被打乱 / 存在上游已删除的本地快照，也按上游列表重排一次。
    cm_db.set_ncm_playlist_orders(uid, [pl["ncm_pl_id"] for pl in pls])
    cm_db.update_binding_sync(uid, imported)
    pending = len(pls) - imported - failed
    out_pls.sort(key=lambda p: (int(p.get("ncmOrder") or 0), int(p.get("id") or 0)))
    log.info("NCM 歌单同步 uid=%s imported=%s failed=%s pending=%s tracks=%s", uid, imported, failed, pending, total)
    return {"imported": imported, "failed": failed, "pending": pending, "tracks": total, "playlists": out_pls}


def _payload_daily(u):
    """每日推荐（含登录用户的「猜你喜欢」）。原 /daily 逻辑，抽出来供 /bootstrap 复用。"""
    cached = cm_db.cache_get("daily:v1")
    daily = json.loads(cached) if cached else None
    if not daily:
        try:
            daily = cm_ncm.recommend_daily()
            cm_db.cache_set("daily:v1", json.dumps(daily, ensure_ascii=False), 6 * 3600)
        except cm_ncm.NcmError:
            daily = []
    out = {"daily": daily, "forYou": [], "artists": []}
    if u:
        import random
        artists = cm_db.top_liked_artists(u["id"], n=5)
        out["artists"] = artists
        if artists:
            import datetime
            seed = f"{datetime.date.today()}:{u['id']}"
            rng = random.Random(seed)
            exclude = set(cm_db.like_ids(u["id"], "likes")) | set(cm_db.like_ids(u["id"], "favs"))
            cand = []
            for a in artists:
                akey = f"foryou:{a}:{datetime.date.today()}"
                ac = cm_db.cache_get(akey)
                if ac:
                    cand.extend(json.loads(ac))
                    continue
                try:
                    res = cm_ncm.search(a, limit=20)
                    cm_db.cache_set(akey, json.dumps(res, ensure_ascii=False), 12 * 3600)
                    cand.extend(res)
                except cm_ncm.NcmError:
                    continue
            seen, pool = set(), []
            for s in cand:
                sid = s.get("ncm_id")
                if sid and sid not in exclude and sid not in seen:
                    seen.add(sid)
                    pool.append(s)
            rng.shuffle(pool)
            out["forYou"] = pool[:12]
    return out


def _payload_me(u):
    """当前用户资料 + 统计 + 挂件解锁状态。原 /auth/me 逻辑。"""
    out = public_user(u)
    protection = cm_2fa.status(u["id"])
    out["twoFactorEnabled"] = protection["enabled"]
    out["securityQuestionEnabled"] = protection["securityQuestionEnabled"]
    out["loginVerificationMethod"] = protection["verificationMethod"]
    # 通行证公开标识（sub）：首次访问时生成，前端「设置 → 通行证」直接展示/复制
    out["passportUid"] = cm_db.passport_uid(u["id"])
    out["stat"] = cm_db.user_stat(u["id"])          # 已含 listenMs，无需再查一次
    # 挂件解锁状态：首页横幅/「我的」页据此决定文案，省掉一次 402 项的目录请求
    out["decorUnlocked"] = int(out["stat"].get("listenMs") or 0) >= cm_db.DECOR_MIN_MS
    out["decorMinMs"] = cm_db.DECOR_MIN_MS
    return out


def _payload_bind(u):
    """网易云绑定状态。原 /ncmbind GET 逻辑（含老绑定惰性回填）。"""
    b = cm_db.get_binding(u["id"])
    if not b:
        return {"bound": False}
    # 老绑定（v1.2.0 之前同步）缺 ncm_liked_pl_id：惰性回填一次（读上游 user/playlist 首项）
    if not b["ncm_liked_pl_id"] and b["ncm_uid"]:
        try:
            pls = cm_ncm.user_playlists(b["cookie"], b["ncm_uid"])
            if pls:
                cm_db.set_binding_liked_pl(u["id"], pls[0]["ncm_pl_id"])
                b = cm_db.get_binding(u["id"]) or b
        except Exception as e:  # noqa: BLE001 回填失败不影响主流程
            log.warning("ncm_liked_pl_id 回填失败 uid=%s: %s", u["id"], e)
    # 前端路由用本地歌单 id，这里把 NCM 侧「我喜欢」歌单 id 映射成本地 id
    local_liked = cm_db.find_ncm_playlist(u["id"], b["ncm_liked_pl_id"]) if b["ncm_liked_pl_id"] else None
    return {
        "bound": True,
        "profile": {"uid": b["ncm_uid"], "nickname": b["ncm_nickname"], "avatar": b["ncm_avatar"]},
        "ncmLikedPlId": local_liked or 0,
        "lastSync": b["last_sync"], "lastSyncCount": b["last_sync_count"], "stale": bool(b["stale"]),
    }


def _share_song(ncm_id):
    """取分享用的归一化歌曲信息（1 天缓存）。"""
    key = f"share:song:{int(ncm_id)}"
    cached = cm_db.cache_get(key)
    if cached:
        return json.loads(cached)
    try:
        songs = cm_ncm.song_detail([int(ncm_id)])
    except Exception as e:  # noqa: BLE001 上游异常转可读错误
        raise ApiError(502, f"歌曲信息获取失败：{e}")
    if not songs:
        raise ApiError(404, "歌曲不存在")
    song = songs[0]
    cm_db.cache_set(key, json.dumps(song, ensure_ascii=False), 86400)
    return song


def _share_ncm_playlist(pid):
    """网易云歌单分享元数据（缓存 1 小时）。"""
    key = f"share:playlist:{int(pid)}"
    cached = cm_db.cache_get(key)
    if cached:
        return json.loads(cached)
    try:
        d = cm_ncm.call("/playlist/detail", {"id": int(pid)}, timeout=20.0, retries=1)
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f"歌单信息获取失败：{e}")
    pl = (d or {}).get("playlist") or {}
    if not pl.get("id"):
        raise ApiError(404, "歌单不存在")
    meta = {
        "name": pl.get("name") or "",
        "pic": cm_ncm._https(pl.get("coverImgUrl") or ""),
        "creator": ((pl.get("creator") or {}).get("nickname") or ""),
        "trackCount": int(pl.get("trackCount") or len(pl.get("trackIds") or [])),
    }
    cm_db.cache_set(key, json.dumps(meta, ensure_ascii=False), 3600)
    return meta


def _share_local_playlist(pid):
    """CurrentMusic 自建歌单分享元数据。"""
    pl = cm_db.get_playlist(int(pid))
    if not pl:
        raise ApiError(404, "歌单不存在")
    owner = cm_db.get_user(pl.get("user_id")) or {}
    count = len(cm_db.playlist_track_ids(int(pid)))
    return {
        "name": pl.get("name") or "",
        "pic": pl.get("cover") or "",
        "owner": owner.get("nickname") or owner.get("username") or "",
        "description": (pl.get("description") or "")[:200],
        "trackCount": count,
    }


def _share_artist(aid):
    key = f"share:artist:{int(aid)}"
    cached = cm_db.cache_get(key)
    if cached:
        return json.loads(cached)
    try:
        d = cm_ncm.call("/artists", {"id": int(aid)}, timeout=20.0, retries=1)
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f"歌手信息获取失败：{e}")
    a = (d or {}).get("artist") or {}
    if not a.get("id") and not a.get("name"):
        raise ApiError(404, "歌手不存在")
    meta = {
        "name": a.get("name") or "",
        "pic": cm_ncm._https(a.get("picUrl") or a.get("img1v1Url") or ""),
        "alias": " / ".join((a.get("alias") or [])[:2]),
        "total": int(a.get("musicSize") or 0),
        "albumTotal": int(a.get("albumSize") or 0),
    }
    cm_db.cache_set(key, json.dumps(meta, ensure_ascii=False), 86400)
    return meta


def _share_album(aid):
    key = f"share:album:{int(aid)}"
    cached = cm_db.cache_get(key)
    if cached:
        return json.loads(cached)
    try:
        d = cm_ncm.call("/album", {"id": int(aid)}, timeout=20.0, retries=1)
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, f"专辑信息获取失败：{e}")
    al = (d or {}).get("album") or {}
    if not al.get("id") and not al.get("name"):
        raise ApiError(404, "专辑不存在")
    meta = {
        "name": al.get("name") or "",
        "pic": cm_ncm._https(al.get("picUrl") or ""),
        "artist": " / ".join((a.get("name") or "") for a in (al.get("artists") or []) if a.get("name")),
        "size": int(al.get("size") or len((d or {}).get("songs") or [])),
        "publishTime": int(al.get("publishTime") or 0),
        "company": al.get("company") or "",
    }
    cm_db.cache_set(key, json.dumps(meta, ensure_ascii=False), 86400)
    return meta


def _share_payload(handler, kind, oid):
    """分享元数据：链接/文案按当前请求站点生成，image 指向服务端渲染图。"""
    proto = "https" if handler.headers.get("X-Forwarded-Proto") == "https" else "http"
    host = (handler.headers.get("Host") or DEFAULT_HOST).strip()
    origin = f"{proto}://{host}"
    oid = int(oid)
    if kind == "song":
        data = _share_song(oid)
        name, pic = data.get("name") or "", data.get("pic") or ""
        sub = data.get("artists") or ""
        sub2 = data.get("album") or ""
        landing = f"/song/{oid}"
        lines = [f"🎵 {name}" + (f" - {sub}" if sub else "")]
        if sub2:
            lines.append(f"专辑：{sub2}")
        cta = "在 CurrentMusic 收听"
        body = {
            "id": oid, "name": name, "artists": sub, "album": sub2,
            "pic": pic, "duration": data.get("duration") or 0,
        }
    elif kind == "playlist":
        data = _share_ncm_playlist(oid)
        name, pic = data["name"], data["pic"]
        sub = data.get("creator") or "网易云歌单"
        sub2 = f'{data.get("trackCount") or 0} 首'
        landing = f"/ncmpl/{oid}"
        lines = [f"🎵 歌单：{name}"]
        if data.get("creator"):
            lines.append(f"创建者：{data['creator']}")
        lines.append(sub2)
        cta = "在 CurrentMusic 打开歌单"
        body = {"id": oid, "name": name, "creator": data.get("creator") or "",
                "trackCount": data.get("trackCount") or 0, "pic": pic}
    elif kind == "local-playlist":
        data = _share_local_playlist(oid)
        name, pic = data["name"], data["pic"]
        sub = data.get("owner") or data.get("description") or "CurrentMusic 歌单"
        sub2 = f'{data.get("trackCount") or 0} 首'
        landing = f"/pl/{oid}"
        lines = [f"🎵 歌单：{name}"]
        if data.get("description"):
            lines.append(data["description"])
        lines.append(sub2)
        cta = "在 CurrentMusic 打开歌单"
        body = {"id": oid, "name": name, "owner": data.get("owner") or "",
                "description": data.get("description") or "",
                "trackCount": data.get("trackCount") or 0, "pic": pic}
    elif kind == "artist":
        data = _share_artist(oid)
        name, pic = data["name"], data["pic"]
        sub = data.get("alias") or "歌手"
        sub2 = " · ".join(x for x in (
            f'{data.get("total") or 0} 首作品' if data.get("total") else "",
            f'{data.get("albumTotal") or 0} 张专辑' if data.get("albumTotal") else "") if x)
        landing = f"/artist/{oid}"
        lines = [f"🎤 歌手：{name}"]
        if data.get("alias"):
            lines.append(data["alias"])
        if sub2:
            lines.append(sub2)
        cta = "在 CurrentMusic 查看歌手"
        body = {"id": oid, "name": name, "alias": data.get("alias") or "",
                "total": data.get("total") or 0,
                "albumTotal": data.get("albumTotal") or 0, "pic": pic}
    elif kind == "album":
        data = _share_album(oid)
        name, pic = data["name"], data["pic"]
        sub = data.get("artist") or ""
        date = ""
        if data.get("publishTime"):
            date = time.strftime("%Y-%m-%d", time.localtime(int(data["publishTime"]) / 1000))
        sub2 = " · ".join(x for x in (date, f'{data.get("size") or 0} 首') if x)
        landing = f"/album/{oid}"
        lines = [f"💿 专辑：{name}" + (f" - {sub}" if sub else "")]
        if sub2:
            lines.append(sub2)
        if data.get("company"):
            lines.append(data["company"])
        cta = "在 CurrentMusic 打开专辑"
        body = {"id": oid, "name": name, "artist": sub, "size": data.get("size") or 0,
                "publishTime": data.get("publishTime") or 0,
                "company": data.get("company") or "", "pic": pic}
    else:
        raise ApiError(400, "不支持的分享类型")

    share_url = f"{origin}/app/#{landing}"
    lines += ["", f"{cta}：{share_url}"]
    body.update({
        "type": kind, "sub": sub, "sub2": sub2,
        "url": share_url, "text": "\n".join(lines),
        "image": f"{origin}/cm/share/{kind}/{oid}/image",
    })
    return body


def _roaming_binding(handler):
    """私人漫游使用调用者自己的网易云账号 cookie（T1），不能注入服务器账号。"""
    u = require_user(handler)
    b = cm_db.get_binding(u["id"])
    if not b or not b.get("cookie"):
        raise ApiError(401, "请先绑定网易云账号后再使用私人漫游")
    return u, b["cookie"]


def _roaming_song(raw):
    """把 /personal/fm/mode 的歌曲对象归一化为 CurrentMusic 歌曲结构。"""
    if not isinstance(raw, dict):
        return None
    s = raw.get("songInfo") if isinstance(raw.get("songInfo"), dict) else raw
    if not isinstance(s.get("id"), (int, str)) or not str(s.get("name") or "").strip():
        return None
    ar = s.get("ar") or s.get("artists") or []
    al = s.get("al") or s.get("album") or {}
    try:
        return cm_ncm._norm_song({
            "id": int(s["id"]),
            "name": s.get("name") or "",
            "ar": ar,
            "al": al if isinstance(al, dict) else {},
            "dt": s.get("dt") or s.get("duration") or 0,
            "fee": s.get("fee"),
            "pop": s.get("popularity") or s.get("pop") or 0,
            "mv": s.get("mv") or s.get("mvid") or 0,
        }, pop=s.get("popularity") or s.get("pop") or 0)
    except (TypeError, ValueError):
        return None


def _roaming_songs(cookie, mode, sub_mode, limit, exclude_ids, real_ip=None):
    q = {"mode": mode, "limit": int(limit)}
    if sub_mode:
        # API-enhanced 的参数名是 submode（小写 m）。
        q["submode"] = sub_mode
    try:
        d = cm_ncm.call("/personal/fm/mode", q, cookie=cookie, timeout=20.0, retries=1,
                        real_ip=real_ip)
    except cm_ncm.NcmError as e:
        raise ApiError(502, f"漫游推荐获取失败：{e}")
    code = (d or {}).get("code")
    if code in (301, 401):
        raise ApiError(401, "网易云登录已失效，请重新绑定")
    if code not in (None, 200):
        raise ApiError(502, f"网易云漫游返回错误码 {code}")
    data = (d or {}).get("data")
    raw_songs = data if isinstance(data, list) else ((data or {}).get("songs") if isinstance(data, dict) else [])
    blocked = {int(x) for x in exclude_ids}
    out, seen = [], set()
    for raw in raw_songs or []:
        song = _roaming_song(raw)
        if not song or not song.get("ncm_id") or song["ncm_id"] in blocked or song["ncm_id"] in seen:
            continue
        seen.add(song["ncm_id"])
        out.append(song)
    return out[:int(limit)]


def _ncm_listen_event(ncm_id, action, seconds=None):
    """构造网易云 /api/feedback/weblog 的听歌事件（与 CurrentMusicX 同口径）。"""
    payload = {
        "id": int(ncm_id), "type": "song", "mainsite": "1", "mainsiteWeb": "1",
        "source": "list", "sourceId": "0", "content": "id=0",
    }
    if action == "play":
        payload.update({
            "download": 0, "end": "playend", "time": max(1, int(seconds or 60)),
            "wifi": 0,
        })
    return {"action": action, "json": payload}


def _spawn_ncm_listen(cookie, ncm_id, action, seconds=None, rowid=None, real_ip=None):
    """异步写用户绑定网易云账号的听歌历史；失败只回滚同步标记，不影响本地播放。"""
    def run():
        try:
            if action == "play":
                # startplay 已在开始播放时尽力写过；这里用 API-enhanced 的 /scrobble
                # （eapi 通道，startplay+play）确保进入网易云听歌记录/排行。
                result = cm_ncm.scrobble(cookie, ncm_id, seconds, timeout=15.0, real_ip=real_ip)
                if isinstance(result, dict) and result.get("code") not in (None, 200):
                    raise RuntimeError(f"NCM scrobble code={result.get('code')}")
            else:
                cm_ncm.weblog(cookie, [_ncm_listen_event(ncm_id, action, seconds)],
                              timeout=10.0, real_ip=real_ip)
        except Exception as e:  # noqa: BLE001 外部账号同步不能阻断播放
            if rowid:
                cm_db.reset_play_sync(rowid)
            log.info("网易云听歌同步失败 song=%s action=%s: %s", ncm_id, action, e)
    threading.Thread(target=run, name="ncm-listen-sync", daemon=True).start()


def _payload_recent(u, limit=20):
    """最近播放。原 /plays/recent 逻辑。"""
    ids = cm_db.recent_plays(u["id"], int(limit))
    return {"songs": cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids))}


def _run_isolated(tasks):
    """并行执行 {key: 无参函数}，单项失败只让该项为 None，绝不影响其它项。

    聚合端点必须比逐个请求更"抗坏"：某一项上游超时/报错时，首页其余内容照常显示。
    """
    out = {}
    if not tasks:
        return out
    with ThreadPoolExecutor(max_workers=max(1, min(8, len(tasks)))) as ex:
        futs = {k: ex.submit(fn) for k, fn in tasks.items()}
        for k, f in futs.items():
            try:
                out[k] = f.result()
            except Exception as e:  # noqa: BLE001 单项失败不影响整体
                log.warning("bootstrap 子项 %s 失败: %s", k, e)
                out[k] = None
    return out


def rate_limited(ip):
    now = time.time()
    with _rl_lock:
        b = _rl_buckets[ip]
        while b and now - b[0] > _RL_WINDOW:
            b.popleft()
        if len(b) >= _RL_LIMIT:
            return True
        b.append(now)
        if len(_rl_buckets) > 5000:  # 防字典膨胀
            for k in list(_rl_buckets):
                if not _rl_buckets[k] or now - _rl_buckets[k][-1] > _RL_WINDOW:
                    del _rl_buckets[k]
        return False


def auth_rate_limited(ip):
    """认证入口专用限速（30/min/IP）；与全站桶分开，避免互相挤占。"""
    now = time.time()
    with _auth_lock:
        b = _auth_buckets[ip]
        while b and now - b[0] > _AUTH_WINDOW:
            b.popleft()
        if len(b) >= _AUTH_LIMIT:
            return True
        b.append(now)
        if len(_auth_buckets) > 5000:
            for k in list(_auth_buckets):
                if not _auth_buckets[k] or now - _auth_buckets[k][-1] > _AUTH_WINDOW:
                    del _auth_buckets[k]
        return False


# ---------- 服务端自动最高音质：探测特殊档（复用插件 v2.8.x 经验） ----------

def _probe_one(ncm_id, level, real_ip=None):
    """取某档的地址与元信息，**不做** 2KB 音频头校验（校验留给胜出档，见 best_level）。"""
    try:
        r = cm_ncm.song_url(ncm_id, level, real_ip=real_ip, probe=False)
        return level, r
    except cm_ncm.NcmError:
        return level, None


# 解析单飞：预取 + 正播 + 卡顿自愈经常在同一瞬间打同一首歌，
# 合并成一次上游往返（见 cm_stream.SingleFlight）。
_resolve_flight = cm_stream.SingleFlight()


def best_level(ncm_id, real_ip=None, max_br=0):
    """探测档位并择优；结果（档位名）缓存 7 天。返回 ``(档位名, 胜出档位的完整结果或 None)``。

    v1.28.23 起把「取地址」与「校验地址」拆成两段（见 cm_stream 的「档位策略」）：

      1. **一轮并行**取各档的地址与元信息（`probe=False`，不打 CDN）；
      2. 按旧口径（码率优先、真无损次之、体积兜底）择优，**只对胜出的那一档**
         做一次 2KB 音频头校验——拿到 sr/bits/ch，同时保证「下发的地址真能播」；
      3. 校验不通过（上游偶发 HTML 错误页）就按择优顺序顺位重试下一档，
         与旧实现「该档不可用则降档」的语义一致。

    旧实现是 4 个线程各自「上游往返 + 2KB 校验」串行跑，冷启动实测 2.0~2.7s；
    拆开后是 1 轮上游 + 1 次校验。**选出的档位与旧实现相同**（排序键未变）。

    ``max_br``（bps，0=不限）把可选档位限制在该码率以内；只在 ``level=auto`` 时有意义。
    返回的第二个值仍是「胜出档位已经取到的完整结果」，调用方可以直接用，省掉
    「先探测档位、再打一次接口取同一首地址」的第二次上游往返（实测 2.81s → 1.4s）。
    """
    max_br = cm_stream.quantize_max_br(max_br)
    key = f"blevel:{int(ncm_id)}:{max_br}"
    cached = cm_db.cache_get(key)
    if cached:
        return cached.strip('"'), None

    tiers = cm_stream.probe_tiers(max_br)

    def _run_plan():
        with ThreadPoolExecutor(max_workers=max(1, len(tiers))) as ex:
            return list(ex.map(lambda lv: _probe_one(ncm_id, lv, real_ip), tiers))

    # 单飞键含 real_ip：上游按 realIP 选 CDN 边缘，把「给别人选的节点」发给别人
    # 正是要避免的事（与 surl 缓存键同一口径）。
    t_levels = time.time()
    results = _resolve_flight.do(
        f"blevel:{int(ncm_id)}:{max_br}:{real_ip or ''}", _run_plan, timeout=8.0)
    level_ms = int((time.time() - t_levels) * 1000)

    for lv, r in cm_stream.ranked(results, max_br):
        ok, spec = cm_ncm.probe_audio(r["url"])
        if not ok:
            log.info("档位校验未通过 song=%s level=%s（顺位降档）", ncm_id, lv)
            continue
        out = dict(r)
        out["sr"] = spec.get("sr") or 0
        out["bits"] = spec.get("bits") or 0
        out["ch"] = spec.get("ch") or 0
        cm_db.cache_set(key, json.dumps(lv), 7 * 86400)
        if level_ms >= 2000:
            log.warning("档位探测偏慢 song=%s 取址=%dms 档位=%s", ncm_id, level_ms, lv)
        return lv, out
    raise cm_ncm.NcmError("该歌曲不可播放（版权/地区限制）")


# ---------- 播放地址解析（v1.28.23 抗卡顿增强） ----------

# 播放地址缓存 TTL：NCM CDN 直链本身约 20 分钟过期，取一半留足余量。
PLAY_URL_TTL = 600

# 卡顿自愈时「直接换边缘」的年龄上限：缓存地址太旧说明签名快到/已过有效期，
# 这时应该重新解析拿新签名，而不是把旧签名换到另一条线上继续失败。
SWAP_MAX_AGE = 300

# 顺带取证的边缘条数（不含当前线）。每首歌最多多花 4×2KB 的 CDN 流量，
# 由 cm_stream 的全局信号量限流，且只在后台线程里做。
EDGE_PROBE_LIMIT = 4


def _truthy(v) -> bool:
    """宽松布尔：1/true/yes/on（大小写不敏感）。"""
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


# 上次下发给某个（歌曲, 客户端 IP）的边缘。用途：连续 refresh 时**逐条轮换**，
# 而不是每次都挑回同一条线——弱网下往往一条线不行、换一条就好，反复给同一条
# 等于让客户端每 6 秒白试一次。只在进程内、有上限，不写库。
_last_edge = {}
_last_edge_lock = threading.Lock()
_LAST_EDGE_MAX = 4000


def _last_edge_get(key):
    with _last_edge_lock:
        return _last_edge.get(key, "")


def _last_edge_set(key, host):
    if not host:
        return
    with _last_edge_lock:
        _last_edge[key] = host
        if len(_last_edge) > _LAST_EDGE_MAX:
            for k in list(_last_edge)[:_LAST_EDGE_MAX // 2]:
                _last_edge.pop(k, None)


def _attach_edges(out, ncm_id, level, size, url):
    """给响应补上「已验证可互换的其它边缘」。

    只在**已经取证过**（缓存命中）时给，绝不在请求路径上同步取证——取证要花
    2~3 秒，把播放首帧拖慢就本末倒置了。没有缓存就返回原样，由后台线程慢慢取证。
    """
    hosts = cm_stream.edges().get(cm_stream.EdgeCache.key(ncm_id, level, size)) or []
    if hosts:
        out["hosts"] = hosts
    return out


def _remember_url_error(key, exc):
    """只缓存“确定不可播”的上游错误 60 秒，避免客户端重试反复打上游。

    网络超时/风控不缓存——那可能是瞬时问题，不能让用户一分钟内都无法重试。
    """
    msg = str(exc or "")
    if any(x in msg for x in ("不可播放", "未取得播放地址", "版权", "地区")):
        cm_db.cache_set(f"{key}:err", msg, 60)


def resolve_play_url(ncm_id, level="auto", immerse=None, real_ip=None,
                     max_br=0, refresh=False, alts=False, want_host=""):
    """解析播放地址，返回可直接下发的响应 dict。

    与旧实现的差别（都是「后端能做、客户端做不到」的事）：

    1. ``maxBr``：``level=auto`` 时把择优限制在码率上限以内。高音质下最容易卡的是
       母带档（192kHz/24bit、~5.2Mbps、单曲近 200MB），弱网/高峰期让它根本不被选中，
       比「先卡住再降档」少一次失败体验。上限按档位边界向下取整（见 cm_stream）。
    2. ``refresh``：卡顿自愈专用。旧行为是**返回 10 分钟缓存里的同一条地址**——
       客户端拿着同一条坏线每 6 秒重试一次，这就是「一直卡」的成因。
       现在：缓存地址还年轻且有已验证的其它边缘 → **毫秒级换一条 CDN 线**返回；
       否则重新解析拿新签名（并尽量换线）。
    3. ``alts``：响应里附带 ``hosts``（已验证可互换的边缘），客户端可自行换线。
    4. 响应新增 ``host``/``fromCache``/``switched``/``resolvedMs``/``expireAt``，
       卡顿上报接口据此知道「是哪条线卡的」。

    ``want_host`` 允许调用方指定边缘（必须是已验证可互换的，否则忽略）。
    """
    t0 = time.time()
    timing = {}
    max_br = cm_stream.quantize_max_br(max_br)
    auto = (level == "auto")
    req_key = f"surl_req:{ncm_id}:{level}:{immerse or ''}:{max_br}:{real_ip}"
    cached_err = cm_db.cache_get(f"{req_key}:err")
    if cached_err:
        raise cm_ncm.NcmError(cached_err)
    probed = None
    if auto:
        try:
            level, probed = best_level(ncm_id, real_ip, max_br)
        except cm_ncm.NcmError as e:
            _remember_url_error(req_key, e)
            raise
    elif level not in VALID_LEVELS:
        level = "lossless"
    # 只有 auto 受码率上限约束；显式档位是调用方明确要的，不越权改它。
    eff_br = max_br if auto else 0
    rt_key = f"surl:{ncm_id}:{level}:{immerse or ''}:{eff_br}:{real_ip}"

    cached_raw = cm_db.cache_get(rt_key)
    cached = json.loads(cached_raw) if cached_raw else None
    prev_host = (cached or {}).get("host") or cm_stream.host_of((cached or {}).get("url") or "")
    age = (time.time() - (cached or {}).get("cachedAt", 0)) if cached else 0
    # 连续 refresh 要逐条换线，所以「当前线」取**上次下发的那条**，而不是缓存里的主地址。
    edge_key = f"{ncm_id}:{real_ip or ''}"
    handed = _last_edge_get(edge_key)

    def _finish(out, from_cache, switched=False):
        out["host"] = out.get("host") or cm_stream.host_of(out.get("url") or "")
        out["fromCache"] = bool(from_cache)
        out["switched"] = bool(switched)
        out["resolvedMs"] = int((time.time() - t0) * 1000)
        if not from_cache and out["resolvedMs"] >= 2500:
            log.warning("播放地址解析偏慢 song=%s level=%s 总=%dms 上游=%sms 探测=%sms host=%s",
                        ncm_id, out.get("level") or level, out["resolvedMs"],
                        timing.get("upstreamMs", "-"), timing.get("probeMs", "-"),
                        out["host"] or "?")
        _last_edge_set(edge_key, out["host"])
        # 为下一次卡顿自愈准备好「可换的边缘」。**缓存命中时也要跑**——否则重启后
        # 或复播时（地址在 10 分钟缓存里）永远没人去取证，refresh 就只能干等上游。
        # spawn_discover 自身有「已有缓存/正在取证就跳过」的判断，调用很便宜。
        if not immerse:
            cm_stream.spawn_discover(ncm_id, out.get("level") or level, out.get("size") or 0,
                                     out.get("url") or "", limit=EDGE_PROBE_LIMIT)
        if alts:
            _attach_edges(out, ncm_id, out.get("level") or level, out.get("size") or 0,
                          out.get("url") or "")
        return out

    # ---- refresh：卡顿自愈，优先「换线」而不是「重拿同一条线」 ----
    if refresh and cached:
        key = cm_stream.EdgeCache.key(ncm_id, cached.get("level") or level, cached.get("size") or 0)
        hosts = cm_stream.edges().get(key) or []
        current = handed or prev_host
        target = want_host if (want_host in hosts and want_host != current) \
            else cm_stream.pick_edge(hosts, current=current)
        if target and age <= SWAP_MAX_AGE:
            out = dict(cached)
            out["url"] = cm_stream.with_host(cached.get("url") or "", target)
            out["host"] = target
            log.info("卡顿自愈换线 song=%s %s → %s（缓存 %.0fs，未打上游）",
                     ncm_id, current or "?", target, age)
            return _finish(out, from_cache=True, switched=True)
    elif cached and not refresh:
        out = dict(cached)
        hosts = cm_stream.edges().get(cm_stream.EdgeCache.key(
            ncm_id, out.get("level") or level, out.get("size") or 0)) or []
        current = handed or prev_host
        target = ""
        if want_host and want_host in hosts and want_host != current:
            target = want_host
        elif current and cm_stream.health().bad(current):
            # 这条线近期被投诉过：缓存命中也别把它再发出去（有别的线就换）
            target = cm_stream.pick_edge(hosts, current=current)
        if target:
            out["url"] = cm_stream.with_host(out.get("url") or "", target)
            out["host"] = target
            return _finish(out, from_cache=True, switched=True)
        return _finish(out, from_cache=True)

    # ---- 常规解析（首次播放 / 缓存过期 / refresh 但没有可用候选线） ----
    try:
        if probed is not None and not immerse:
            r = probed                 # 复用档位探测时已经取到的完整结果
        else:
            r = cm_ncm.song_url(ncm_id, level, immerse, real_ip=real_ip, timing=timing)
    except cm_ncm.NcmError as e:
        _remember_url_error(req_key, e)
        raise
    out = dict(r)
    out["host"] = cm_stream.host_of(out.get("url") or "")

    # 指定了边缘 / 有已取证候选且当前线被投诉过 → 直接落到健康的那条线
    key = cm_stream.EdgeCache.key(ncm_id, out.get("level") or level, out.get("size") or 0)
    hosts = cm_stream.edges().get(key) or []
    switched = False
    if hosts:
        if want_host and want_host in hosts and want_host != out["host"]:
            target = want_host
        elif cm_stream.health().bad(out["host"]):
            target = cm_stream.pick_edge(hosts, current=out["host"])
        else:
            target = ""
        if target:
            out["url"] = cm_stream.with_host(out["url"], target)
            out["host"] = target
            switched = True

    out["cachedAt"] = time.time()
    out["expireAt"] = int((out["cachedAt"] + PLAY_URL_TTL) * 1000)
    cm_db.cache_delete(f"{req_key}:err")
    cm_db.cache_set(rt_key, json.dumps(out, ensure_ascii=False), PLAY_URL_TTL)
    return _finish(out, from_cache=False, switched=switched)


# ---------- 工具 ----------

# ---------- 投屏音源地址缓存 ----------
# 渲染器常对同一地址连发 2~3 次请求（探测/重连），每次都重新探测音质档位要数秒，
# 会让设备判定超时。CDN 链接本身 20 分钟过期，这里按 10 分钟缓存足够安全。
# 投屏并发上限：每个流都占服务端出口带宽，且未缓存时要回源整曲
_CAST_MAX_STREAMS = int(os.environ.get("CM_CAST_MAX_STREAMS", "6"))
_cast_sem = threading.Semaphore(_CAST_MAX_STREAMS)

_cast_urls = {}
_cast_urls_lock = threading.Lock()
# 同一首歌的解析单飞：并发请求各打一次 NCM 探测档位既慢又容易被风控
_cast_resolve_locks = {}


def _resolve_lock(ncm_id):
    with _cast_urls_lock:
        lk = _cast_resolve_locks.get(ncm_id)
        if lk is None:
            lk = threading.Lock()
            _cast_resolve_locks[ncm_id] = lk
            if len(_cast_resolve_locks) > 500:
                for k in list(_cast_resolve_locks)[:250]:
                    _cast_resolve_locks.pop(k, None)
        return lk


def _serve_job(handler, job, chunk_size=64 * 1024):
    """把下载中的音频边下边发给渲染器（多个请求可同时读同一份数据）。

    - 未带 Range 或 bytes=0-：声明完整 Content-Length，随下载推进持续发送
    - 带 Range 且起点已就绪：返回 206 + Content-Range（电视拖进度用）
    - 起点尚未下载到：短暂等待；等不到则 503（让设备稍后重试，而不是给它半截流）
    说明：文件句柄只开一次，下载线程的原子改名不影响已打开的 inode，
    因此读到的一直是同一份数据，不会读到「换名后另一个文件」。
    """
    avail, total, _done, err = job.snapshot()
    if err:
        raise ApiError(502, f"音源下载失败: {err}")
    rng = handler.headers.get("Range") or ""
    mr = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
    start_b, end_b, partial = 0, None, False
    if mr and (mr.group(1) or mr.group(2)):
        if mr.group(1):
            start_b = int(mr.group(1))
            end_b = int(mr.group(2)) if mr.group(2) else None
        elif total > 0:                       # bytes=-N（需要总长，未知则从头发）
            start_b = max(0, total - int(mr.group(2) or 0))
            end_b = total - 1
        partial = True
    if total > 0:
        if start_b >= total:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{total}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        if end_b is None or end_b >= total:
            end_b = total - 1
    if start_b > 0:
        avail = job.wait_bytes(start_b + 1, timeout=25.0)
        if avail <= start_b:
            raise ApiError(503, "音频尚未就绪，请稍后重试")
    length = (end_b - start_b + 1) if end_b is not None else (
        max(0, total - start_b) if total > 0 else 0)
    handler.send_response(206 if partial else 200)
    handler.send_header("Content-Type", cm_cast.mime_of(job.ext))
    handler.send_header("Accept-Ranges", "bytes")
    if length > 0:
        handler.send_header("Content-Length", str(length))
    else:
        handler.send_header("Connection", "close")
    if partial:
        handler.send_header("Content-Range",
                            f"bytes {start_b}-{end_b}/{total if total > 0 else '*'}")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    # 等首批数据落盘再打开：下载线程刚启动时 .part 可能还不存在（不能直接 open）
    if job.wait_bytes(start_b + 1, timeout=20.0) <= start_b:
        _a, _t, _d, err = job.snapshot()
        if err:
            raise ApiError(502, f"音源下载失败: {err}")
        raise ApiError(503, "音频尚未就绪，请稍后重试")
    pos = start_b
    f = open(job.path(), "rb")
    try:
        while True:
            if end_b is not None and pos > end_b:
                break
            avail, _t, done, err = job.snapshot()
            if avail <= pos:
                if done or err:
                    break
                job.wait_bytes(pos + 1, timeout=30.0)
                continue
            want = chunk_size if end_b is None else min(chunk_size, end_b - pos + 1)
            f.seek(pos)
            data = f.read(want)
            if not data:
                if done or err:
                    break
                time.sleep(0.05)
                continue
            handler.wfile.write(data)
            pos += len(data)
    finally:
        f.close()


# 投屏音质降级梯：从最好到最差。用户默认要最高（超清母带），
# 但并非每首歌都有母带/无损资源（版权、下架、地区限制），故逐档下探，
# 保证「一定有可用音源」，而不是直接报错。
CAST_LADDER = tuple(reversed(VALID_LEVELS))   # jymaster → … → standard
# 投屏默认档：绝大多数 DLNA 渲染器都能正确解码 320k MP3。
# 曾经默认「最高」（超清母带 = 192kHz/24bit FLAC）——很多电视**接受连接却按错误
# 参数解码**（192k 数据按 48k 放 = 慢放 4 倍、音调低两个八度），而且"正在播放"
# 不会触发任何失败回调，前端降级梯永远不启动，用户听到的就是"慢放数百倍"的恐怖声。
CAST_DEFAULT = "exhigh"


def _cast_spec_unsafe(info):
    """按文件头实测规格判断该档位是否不适合投屏（>48kHz 或多声道）。

    song_url() 自 v1.28.2 起返回 sr/bits/ch（取自文件头 STREAMINFO），
    这里用实测值而非档位名——上游常把 hires 降级成 44.1k 无损，那样其实是安全的。
    """
    sr = int(info.get("sr") or 0)
    ch = int(info.get("ch") or 0)
    return sr > 48000 or ch > 2


def cast_resolve(ncm_id, level=None, allow_downgrade=True):
    """取（可缓存的）投屏音源地址，返回 (url, ext, level)。

    level=None/"auto" 表示「默认」：从 CAST_DEFAULT（极高 320k MP3）开始。
    指定档位时从该档往下；**任何实际规格超过 48kHz 或多声道的档都会被跳过**
    （见 _cast_spec_unsafe 注释——那是电视"慢放恐怖声"的来源）。
    拿到锁后复查缓存，避免并发请求重复探测（探测很慢且易被风控）。
    """
    now = time.time()
    if level is None:
        with _cast_urls_lock:
            e = _cast_urls.get(ncm_id)
        if e and now - e[3] < 600:
            return e[0], e[1], e[2]
    with _resolve_lock(ncm_id):
        with _cast_urls_lock:
            e = _cast_urls.get(ncm_id)
        if e and now - e[3] < 600 and level is None:
            return e[0], e[1], e[2]
        # 起点：未指定 / "auto" / 非法 → 投屏默认档（设备安全）；指定了 → 从该档往下
        if not level or level == "auto" or level not in VALID_LEVELS:
            start = CAST_DEFAULT
        else:
            start = level
        ladder = list(CAST_LADDER)
        if start in ladder:
            ladder = ladder[ladder.index(start):]           # 从指定档位往下
        if not allow_downgrade:
            ladder = ladder[:1]
        last_err = None
        skipped = []
        for lv in ladder:
            try:
                info = cm_ncm.song_url(ncm_id, lv)
                if _cast_spec_unsafe(info):
                    # 电视"能连上但放不动"的档位：直接跳过，绝不投给渲染器
                    skipped.append(lv)
                    continue
                url, ext = info["url"], cm_cast._safe_ext(lv, info.get("url"))
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                continue
        else:
            if skipped:
                raise ApiError(502, "该档位为 96/192kHz 或多声道，多数电视无法正常解码（会慢放/变调），已阻止投屏"
                               + (f"；其余档位：{last_err}" if last_err else ""))
            raise ApiError(502, f"无可用音源: {last_err}")
    with _cast_urls_lock:
        _cast_urls[ncm_id] = (url, ext, lv, now)
        if len(_cast_urls) > 500:      # 防无界增长：淘汰最旧的一半
            for k in sorted(_cast_urls, key=lambda k: _cast_urls[k][3])[:250]:
                _cast_urls.pop(k, None)
    return url, ext, lv


def jresp(handler, code, obj, cache_control=None):
    if urlparse(handler.path).path.startswith(("/auth/passkeys", "/auth/2fa/", "/auth/security-question")) or (isinstance(obj, dict) and (obj.get("requires2FA") or obj.get("requiresSecurityQuestion"))):
        cache_control = "no-store"
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    if cache_control:
        handler.send_header("Cache-Control", cache_control)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def hresp(handler, code, html):
    """HTML 响应（通行证文档页等；不缓存，避免发版后仍看到旧文档）。"""
    body = html.encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def docs_redirect(handler, section):
    """历史文档入口统一跳转到 API 文档站，保留主站与镜像的同源访问。"""
    handler.send_response(302)
    handler.send_header("Location", "/api-docs/reference/" + section + "/")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def serve_file(handler, fp, content_type, download_name=None, cache="public, max-age=3600"):
    """流式分发本地文件，带 Range 支持（安装包共用）。

    为什么要 Range：安卓系统下载器与浏览器在断网、切后台后会带 `Range` 续传，
    不支持时只能整包重下（40MB）；另外部分下载工具会先探测 `Accept-Ranges`。
    """
    size = os.path.getsize(fp)
    start, end = 0, size - 1
    rng = handler.headers.get("Range") or ""
    mr = re.match(r"bytes=(\d*)-(\d*)", rng)
    if mr:
        if not mr.group(1) and mr.group(2):
            # 后缀区间 `bytes=-N`：RFC 7233 规定是**最后 N 字节**，
            # 不能当成 `0-N`（旧实现按后者处理，会返回错的内容区间）
            start = max(0, size - int(mr.group(2)))
            end = size - 1
        else:
            if mr.group(1):
                start = min(int(mr.group(1)), max(0, size - 1))
            if mr.group(2):
                end = min(int(mr.group(2)), max(0, size - 1))
    length = max(0, end - start + 1)
    handler.send_response(206 if mr else 200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Access-Control-Allow-Origin", "*")   # 便于网页端/调试测速
    if download_name:
        handler.send_header("Content-Disposition",
                            f'attachment; filename="{download_name}"; filename*=UTF-8\'\'{quote(download_name)}')
    if mr:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.send_header("Content-Length", str(length))
    handler.send_header("Cache-Control", cache)
    handler.end_headers()
    with open(fp, "rb") as f:
        f.seek(start)
        left = length
        while left > 0:
            chunk = f.read(min(65536, left))
            if not chunk:
                break
            handler.wfile.write(chunk)
            left -= len(chunk)


def base_url(handler):
    """本服务的对外基址（兼容 Cloudflare / 反代）。"""
    host = handler.headers.get("Host") or DEFAULT_HOST
    proto = "https" if handler.headers.get("X-Forwarded-Proto") == "https" else "http"
    return f"{proto}://{host}"


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def require_admin(handler):
    """要求管理员或超级管理员（面板/公告管理用）。站长隐含超管+管理员，一并放行。"""
    u = require_user(handler)
    if not (u.get("is_admin") or u.get("is_super") or u.get("is_owner")):
        raise ApiError(403, "需要管理员权限")
    return u


# 站内角色等级：站长(2) > 超管(1) > 管理员(0)。用于「不能对更高角色动手」的越权保护。
def role_rank(u):
    if not u:
        return -1
    if u.get("is_owner"):
        return 2
    if u.get("is_super"):
        return 1
    if u.get("is_admin"):
        return 0
    return -1


def optional_user(handler):
    """未登录返回 None（不抛 401）；帖子流游客可看，登录则附带互动状态。"""
    auth = handler.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.startswith("Bearer ") else ""
    if not token:
        return None
    u = cm_db.user_by_token(token)
    return u if u and not u.get("disabled") else None


def require_user(handler):
    auth = handler.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.startswith("Bearer ") else ""
    if not token:
        # SSE(EventSource) / 长轮询无法携带自定义请求头 → 允许从查询参数取 token
        try:
            token = (parse_qs(urlparse(handler.path).query).get("token") or [""])[0].strip()
        except Exception:  # noqa: BLE001
            token = ""
    if not token:
        raise ApiError(401, "未登录")
    u = cm_db.user_by_token(token)
    if not u:
        raise ApiError(401, "登录已失效，请重新登录（会话可能已退出或被下线）")
    u["_token"] = token
    # v1.28.38：顺带刷新 IP 属地（内部已节流 + 异步，异常静默，绝不影响鉴权）
    cm_region.note(u["id"], cm_ncm_gateway.client_ip(handler))
    return u


def _get_room(handler, ident):
    """按 id 或 code 取房间（须存在且未关闭）。"""
    room = cm_rooms.get_room(code=ident) if not ident.isdigit() else cm_rooms.get_room(room_id=int(ident))
    if not room:
        room = cm_rooms.get_room(code=ident)   # 可能是短 id 但实际是 code
    if not room:
        raise ApiError(404, "房间不存在或已关闭")
    return room


def _require_role(handler, room, min_role):
    """校验当前用户在指定房间的角色。min_role: owner > admin > member"""
    u = require_user(handler)
    member = cm_rooms.get_member(room["id"], u["id"])
    if not member:
        raise ApiError(403, "请先加入房间")
    role = member["role"]
    if min_role == "owner" and role != "owner":
        raise ApiError(403, "需要房主权限")
    if min_role == "admin" and role not in ("owner", "admin"):
        raise ApiError(403, "需要房主或管理员权限")
    return member


def _room_out(room, uid, brief=False):
    d = {
        "id": room["id"], "code": room["code"], "name": room["name"],
        "ownerId": room["owner_id"], "isPublic": bool(room["is_public"]),
        "freeMode": bool(room["free_mode"]), "needApproval": bool(room["need_approval"]),
        "joinLocked": bool(room["join_locked"]), "hasPassword": bool(room["password_hash"]),
        "maxMembers": room["max_members"],
    }
    if not brief:
        d["timeline"] = cm_rooms.get_timeline(room)
    return d


def _member_out(m, decor=""):
    return {"userId": m["user_id"], "role": m["role"], "nickname": m["nickname"],
            "avatar": m["avatar"], "avatarDecoration": decor or "",
            "title": m.get("title") or "",            # 站内头衔（list_members 里 join users 带出）
            "isAdmin": bool(m.get("is_admin")), "isSuper": bool(m.get("is_super")),
            "isOwner": bool(m.get("is_owner")),
            "muted": bool(m["muted"])}


def _queue_out(item, uid):
    return {"id": item["id"], "ncmId": item["ncm_id"], "name": item["name"],
            "artists": item["artists"], "pic": item["pic"], "duration": item["duration"],
            "status": item["status"], "seq": item["seq"],
            "requestedBy": item["requested_by"], "requester": item.get("requester", ""),
            "mine": item["requested_by"] == uid}


def _event_out(e):
    return {"seq": e["seq"], "type": e["type"],
            "payload": json.loads(e["payload"]) if isinstance(e["payload"], str) else e["payload"],
            "createdAt": e["created_at"]}


def me_username(handler):
    try:
        return require_user(handler)["username"]
    except Exception:  # noqa: BLE001
        return "?"


def require_admin(handler):
    """管理员校验：会话有效 且 users.is_admin=1。"""
    u = require_user(handler)
    if not u.get("is_admin"):
        raise ApiError(403, "需要管理员权限")
    return u


def device_label(handler, body=None):
    """设备标识：客户端显式上报优先，否则按 UA 归纳（App/网页 + 平台摘要）。"""
    b = body or {}
    dev = str(b.get("device") or "").strip()[:120]
    plat = str(b.get("platform") or "").strip()[:20]
    ua = handler.headers.get("User-Agent", "") or ""
    if not plat:
        plat = "app" if "/" not in ua or "CurrentMusic" in ua else "web"
    if not dev:
        m = re.search(r"Android[ /]([\d.]+)", ua)
        ch = re.search(r"Chrome/([\d.]+)", ua)
        parts = []
        if "Android" in ua:
            parts.append("Android" + (f" {m.group(1)}" if m else ""))
        elif "Windows" in ua:
            parts.append("Windows")
        elif "Mac OS" in ua or "Macintosh" in ua:
            parts.append("macOS")
        elif "Linux" in ua:
            parts.append("Linux")
        if ch:
            parts.append("Chromium " + ch.group(1).split(".")[0])
        dev = " · ".join(parts) or "未知设备"
    return dev, plat


def mask_phone(phone):
    """手机号脱敏展示（138****8888）。"""
    s = str(phone or "")
    return s[:3] + "****" + s[-4:] if len(s) >= 7 else s


def norm_phone(raw):
    """规范化手机号：只留数字；5~15 位（中国 11 位）才视为合法，否则返回空串。"""
    s = re.sub(r"\D", "", str(raw or ""))
    return s if 5 <= len(s) <= 15 else ""


# 短信限流阈值（网易云通道发的是真实短信，必须防轰炸）
SMS_COOLDOWN = 60          # 同一号码重发冷却（秒）
_email_ip_hour = {}        # 登录验证码每 IP 每小时发送记录（进程内；10 条/小时）
SMS_PER_PHONE_DAY = 5      # 同一号码 24h 上限
SMS_PER_IP_HOUR = 10       # 同一 IP 1h 上限


def _friendly_sms_error(e):
    """把上游/网关异常转成可直接展示给用户的提示。

    只透传「我们主动抛出的中文提示」（NcmError / 网关错误），其余一律兜底——
    否则内部异常（NameError 之类）会连同堆栈信息泄漏给客户端。
    """
    msg = str(e or "").strip()
    if msg and len(msg) <= 120 and "Traceback" not in msg and any("\u4e00" <= c <= "\u9fff" for c in msg):
        return msg
    return "验证码发送失败，请稍后重试"


def _password_code_key(email):
    """密码找回/修改码的存储键：``reset:<email>``。

    与注册码（裸邮箱）、登录码（``login:<email>``）、绑定码（``bind:<email>``）
    一样共用 email_codes 表但命名空间隔离——别处的验证码不能拿来重置密码。
    """
    return "reset:" + str(email or "").strip().lower()


def _email_ip_budget(ip, now):
    """邮箱验证码每 IP 每小时 10 条（进程内，与登录/绑定码共用同一份计数）。"""
    cutoff = now - 3600
    _email_ip_hour[ip] = [t for t in _email_ip_hour.get(ip, []) if t > cutoff]
    if len(_email_ip_hour[ip]) >= 10:
        raise ApiError(429, "当前网络请求验证码过于频繁，请稍后再试")


def _check_email_code(email, code, now, key=None):
    """校验邮箱验证码（错误/过期抛 ApiError），通过后立即作废。

    ``key``：验证码存储键。注册码按真实邮箱存；**登录码按 ``login:<email>``
    存**——两套码共用一张表但命名空间隔离，注册验证码不能拿来登录（反之亦然）。
    密码找回码用 :func:`_password_code_key`（``reset:<email>``）。
    """
    k = key or email
    ec = cm_db.get_email_code(k)
    if not ec or ec["expires"] < now:
        raise ApiError(400, "验证码已过期，请重新获取")
    if ec["tries"] >= 5:
        cm_db.delete_email_code(k)
        raise ApiError(400, "错误次数过多，验证码已作废，请重新获取")
    if ec["code"] != code:
        cm_db.bump_email_code_tries(k)
        raise ApiError(400, "验证码错误")
    cm_db.delete_email_code(k)


def _check_phone_code(phone, code, now):
    """校验短信验证码（自建网关本地比对 / 网易云通道走上游校验），通过后立即作废。"""
    pc = cm_db.get_phone_code(phone)
    if not pc or pc["expires"] < now:
        raise ApiError(400, "验证码已过期，请重新获取")
    if pc["tries"] >= 5:
        cm_db.delete_phone_code(phone)
        raise ApiError(400, "错误次数过多，验证码已作废，请重新获取")
    try:
        ok = cm_sms.verify(phone, code, pc["code"], pc["mode"])
    except Exception as e:  # noqa: BLE001 上游风控等
        log.warning("短信验证码校验异常 phone=%s: %s", mask_phone(phone), e)
        raise ApiError(502, _friendly_sms_error(e))
    if not ok:
        cm_db.bump_phone_code_tries(phone)
        raise ApiError(400, "验证码错误")
    cm_db.delete_phone_code(phone)


def public_user(u):
    return {
        "id": u["id"], "username": u["username"], "nickname": u["nickname"],
        "avatar": u["avatar"], "bio": u["bio"], "createdAt": u["created_at"],
        "isAdmin": bool(u.get("is_admin")),        # 前端据此显示管理入口
        "isSuper": bool(u.get("is_super")),        # 超级管理员（广场恒置顶）
        "isOwner": bool(u.get("is_owner")),        # 站长（最高角色，广场置顶优先于超管）
        "title": u.get("title") or "",             # 站内头衔（管理员授予；''=无）——广场/主页等各处展示
        "publicSquare": bool(u.get("public_square", 1)),   # 是否公开到发现页广场
        "avatarDecoration": u.get("avatar_decoration") or "",   # 已选头像挂件 id（''=未设置）
        "phone": mask_phone(u.get("phone")),       # 已绑手机（脱敏），未绑定为空串
        "hasEmail": bool(u.get("email")),          # 是否已绑邮箱（不暴露地址本身，设置页显示用）
        "ipRegion": u.get("ip_region") or "",      # IP 属地（省份/国家，如「安徽」；空=未知）
        "isBot": bool(u.get("is_bot")),            # AI 账号（前端显示 AI 徽章）
    }


def followed_netease(uid, ttl=300):
    """读某用户网易云账号的关注歌手（缓存 ttl 秒）；未绑定/上游失败返回 None。"""
    b = cm_db.get_binding(uid)
    if not b or not b["ncm_uid"]:
        return None
    key = f"nsubpub:{uid}"
    cached = cm_db.cache_get(key)
    if cached:
        return json.loads(cached)
    try:
        d = cm_ncm.artist_sublist(b["cookie"], 100, 0)
    except cm_ncm.NcmError as e:
        log.info("读关注歌手失败 uid=%s: %s", uid, e)
        return None
    cm_db.cache_set(key, json.dumps(d, ensure_ascii=False), ttl)
    return d


def read_json(handler):
    n = int(handler.headers.get("Content-Length") or 0)
    if n <= 0:
        return {}  # 无 body 的 POST（如 qr/key）合法
    if n > MAX_BODY:
        raise ApiError(400, "请求体过大")
    try:
        return json.loads(handler.rfile.read(n).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError(400, "JSON 解析失败")


def norm_meta(m):
    """仅接受安全的元数据字段并限定长度。"""
    if not isinstance(m, dict):
        raise ApiError(400, "meta 格式错误")
    try:
        ncm_id = int(m.get("ncm_id") or m.get("id"))
    except (TypeError, ValueError):
        raise ApiError(400, "缺少 ncm_id")
    name = str(m.get("name") or "").strip()[:200]
    if not name:
        raise ApiError(400, "缺少歌曲名")
    return {
        "ncm_id": ncm_id, "name": name,
        "artists": str(m.get("artists") or "")[:300],
        "album": str(m.get("album") or "")[:200],
        "pic": str(m.get("pic") or "")[:500],
        "duration": int(m.get("duration") or 0),
        "pop": int(m.get("pop") or 0),
        "fee": int(m.get("fee") or 0),
    }


USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5]{2,24}$")


# ---------- 路由分发 ----------

# ---- NCM 上游泛化转发（登记表驱动，见 backend/cm_ncm_registry.py）----
_NCM_BREAKER = cm_ncm_gateway.FamilyBreaker(threshold=5, cooldown=60.0)

# T3 专用入口：路径 -> (上游路径, 是否写操作, 是否必须已绑定网易云)
#
# 为什么单独一张表、并放在泛化转发**之前**拦截：
#   - 这些接口在登记表里是 T3（登录/验证码/注册/换绑/设置），泛化转发对 T3 一律 403，
#     所以它们**只能**由项目显式实现；
#   - 项目侧统一加：Bearer 鉴权 → 绑定校验（能不带就允许）→ 写操作 confirm=1 → 审计日志；
#   - 与 T2 的差别只在"不经登记表放量"，安全属性（用户自己的 cookie、二次确认、审计）**不降级**。
_T3_ROUTES = {
    "/ncm/logout":                 ("/logout", True, True),
    "/ncm/setting":                ("/setting", False, True),
    "/ncm/captcha/sent/v1":        ("/captcha/sent/v1", True, False),
    "/ncm/captcha/safe/sent":      ("/captcha/safe/sent", True, False),
    "/ncm/login":                  ("/login", True, False),
    "/ncm/rebind":                 ("/rebind", True, True),
    "/ncm/user/bindingcellphone":  ("/user/bindingcellphone", True, True),
    "/ncm/user/replacephone":      ("/user/replacephone", True, True),
    "/ncm/register/anonimous":     ("/register/anonimous", True, False),
    "/ncm/register/cellphone":     ("/register/cellphone", True, False),
}


def _ncm_t3(handler, method, path, q, body):
    """T3 专用入口的统一实现（鉴权 → 绑定 → 二次确认 → 审计 → 转发）。"""
    upstream, is_write, need_bind = _T3_ROUTES[path]
    u = require_user(handler)
    cookie = None
    if need_bind:
        b = cm_db.get_binding(u["id"])
        if not b or not b.get("cookie"):
            raise ApiError(401, "请先绑定网易云账号后再使用该功能")
        cookie = b["cookie"]
    if is_write:
        confirm = str(q.get("confirm") or (body or {}).get("confirm") or "")
        if confirm not in ("1", "true", "True"):
            raise ApiError(400, "该操作需要二次确认（confirm=1）")
        log.info("NCM T3 操作审计 user=%s path=%s upstream=%s params=%s",
                 u["id"], path, upstream, sorted(k for k in q if k != "confirm"))
    # 参数走白名单：只透传调用方给的业务参数，并剥掉网关保留项
    params = cm_ncm_gateway.normalize_params(upstream, q, "POST" if is_write else "GET")
    if cookie is None:
        # 未绑定也必须用**调用方身份**：登录/验证码类接口按传参自带 cookie 时优先用之
        params.pop("cookie", None)
    out = cm_ncm.call(upstream, params, cookie=cookie, timeout=20.0) if cookie is not None \
        else cm_ncm.call(upstream, params, with_cookie=False, timeout=20.0)
    jresp(handler, 200, out)
    return True



def _ncm_forward(handler, method, path, q, body):
    """经登记表把 /ncm/<上游路径> 转发到 api-enhanced。

    安全边界（每条都有对应的验收测试）：
      - 白名单：未登记 → 返回 None，由调用方走 404
      - T3：禁止泛化转发 → 403（敏感接口只允许项目专用入口）
      - 阶段门禁：phase > ENABLED_PHASE → 返回 None（未启用的阶段不暴露）
      - cookie 分级：T0 用服务端 SVIP 档并剥离身份字段；T1/T2 必须用调用者自己的
        绑定 cookie，未绑定 → 401
      - T2 写操作：必须 confirm=1，并写审计日志
      - 缓存：仅 T0 GET 按分类 TTL 缓存；账号态一律不缓存
      - 熔断：按接口族，单族故障不影响其它族
    """
    upstream = path[len("/ncm"):] or "/"
    ent = cm_ncm_registry.entry(upstream)
    if not ent:
        return None
    tier, ttl, phase = ent
    if tier == cm_ncm_registry.T3:
        raise ApiError(403, "该接口不允许经通用转发调用，请使用对应功能入口")
    if phase > cm_ncm_registry.ENABLED_PHASE:
        return None

    fam = cm_ncm_registry.family(upstream)
    if not _NCM_BREAKER.allow(fam):
        raise ApiError(503, f"上游暂时不可用（{fam} 已熔断），请稍后重试")

    # 音源仅限注册用户（v1.28.33）：媒体地址族（song/url、mv/url、video/url、
    # 云盘下载、语音）在**查缓存之前**校验登录态——否则游客能直接吃到
    # T0 缓存里的播放直链，鉴权形同虚设。其余接口（搜索/歌词/详情等）保持公开。
    if cm_ncm_gateway.is_media_url_path(upstream):
        require_user(handler)

    cookie = None
    if tier == cm_ncm_registry.T0:
        optional_user(handler)  # 公开只读：游客可用，登录不强制
    else:
        u = require_user(handler)
        binding = cm_db.get_binding(u["id"])
        if not binding or not binding.get("cookie"):
            raise ApiError(401, "请先绑定网易云账号后再使用该功能")
        cookie = binding["cookie"]
        if tier == cm_ncm_registry.T2:
            confirm = str(q.get("confirm") or (body or {}).get("confirm") or "")
            if confirm not in ("1", "true", "True"):
                raise ApiError(400, "写操作需要二次确认（confirm=1）")
            log.info("NCM 写操作审计 user=%s path=%s params=%s", u["id"], path,
                     sorted(k for k in q if k != "confirm"))

    params = cm_ncm_gateway.normalize_params(path, q, method)
    ck = None
    if ttl > 0 and method == "GET" and tier == cm_ncm_registry.T0:
        ck = cm_ncm_gateway.cache_key(upstream, params)
        hit = cm_db.cache_get(ck)
        if hit:
            jresp(handler, 200, json.loads(hit))
            return True          # jresp 本身无返回值：必须显式回 True，
                                 # 否则 route() 会当"未登记"再补写一个 404 响应

    # 媒体地址族：把**调用方 IP** 告诉上游（/song/url/v1 的文档参数 realIP，
    # 上游据此选离用户近的 CDN 边缘；直链本身不绑 IP，实测异地 IP 也能取）。
    # 注意：realIP 在 RESERVED_PARAMS 里被剥掉，这里注入的是服务端取到的真实 IP，
    # 调用方伪造不了；且必须在算缓存键**之后**注入，避免缓存按 IP 碎片化。
    if cm_ncm_gateway.should_forward_real_ip(upstream, method, tier):
        params["realIP"] = cm_ncm_gateway.client_ip(handler)

    # 文件类接口（封面/头像）：文件体走 multipart，其余参数走 query。
    # 白名单在 cm_ncm_gateway.UPLOAD_FIELD；未登记的路径即使带 file 也当普通 JSON 处理。
    field = cm_ncm_gateway.upload_field(upstream) if method == "POST" else None
    try:
        if field:
            try:
                filename, ctype, blob = cm_ncm_gateway.decode_upload(body)
            except ValueError as exc:
                raise ApiError(400, f"上传被拒绝：{exc}") from exc
            log.info("NCM 上传审计 user=%s path=%s file=%s type=%s bytes=%d",
                     locals().get("u", {}).get("id", "-"), path, filename, ctype, len(blob))
            out = cm_ncm.call_multipart(upstream, params, field=field, filename=filename,
                                        content_type=ctype, data=blob, cookie=cookie)
        else:
            out = cm_ncm.call(upstream, params, cookie=cookie)
    except Exception:
        _NCM_BREAKER.record_failure(fam)
        raise
    _NCM_BREAKER.record_success(fam)

    if tier == cm_ncm_registry.T0:
        out = cm_ncm_registry.strip_identity(out)
    # 媒体直链统一升 https（HTTPS 页面加载 http:// 音源 = 混合内容，被浏览器拦死）
    if cm_ncm_gateway.is_media_url_path(upstream):
        out = cm_ncm_gateway.https_upgrade(out)
    if ck:
        cm_db.cache_set(ck, json.dumps(out, ensure_ascii=False), ttl)
    jresp(handler, 200, out)
    return True


def _ncm_like_counts(ids, refresh=False):
    """批量取网易云红心数：先查 6 小时缓存，缺的并发补；失败静默返回已有值。"""
    ids = [int(i) for i in ids][:100]
    out, missing = {}, []
    for nid in ids:
        if not refresh:
            cached = cm_db.cache_get(f"redc:{nid}")
            if cached not in (None, ""):
                try:
                    out[nid] = int(cached)
                    continue
                except (TypeError, ValueError):
                    pass
        missing.append(nid)
    if missing:
        def fetch(nid):
            try:
                return nid, cm_ncm.red_count(nid)
            except Exception:  # noqa: BLE001 单首失败不影响列表
                return nid, None
        with ThreadPoolExecutor(max_workers=min(8, len(missing))) as ex:
            for nid, val in ex.map(fetch, missing):
                if val is not None:
                    out[nid] = val
                    cm_db.cache_set(f"redc:{nid}", str(val), 6 * 3600)
    return out


def route(handler, method):
    parsed = urlparse(handler.path)
    path = parsed.path.rstrip("/") or "/"
    q = {k: v[0] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
    body = read_json(handler) if method in ("POST", "PUT", "DELETE") else None
    # 限速按**真实客户端**分桶。此前用 handler.client_address（= nginx 的 127.0.0.1），
    # 全站共用一个 300/min 的桶：几个用户同时切歌就会把播放地址解析打成 429。
    ip = cm_ncm_gateway.rate_key(handler)
    if rate_limited(ip):
        return jresp(handler, 429, {"error": "请求过于频繁，请稍后再试"})
    if path in _AUTH_PATHS and auth_rate_limited(ip):
        return jresp(handler, 429, {"error": "登录尝试过于频繁，请稍后再试"})

    # ---- 健康检查 ----
    if path == "/network/probe" and method == "GET":
        return jresp(handler, 200, {"service": "CurrentMusic", "ok": True, "now": int(time.time())}, cache_control="no-store")
    if path == "/network/lines" and method == "GET":
        return jresp(handler, 200, cm_lines.snapshot(measure=q.get("measure", "1") != "0"), cache_control="no-store")
    if path in ("/network/docs", "/network/docs/") and method == "GET":
        return docs_redirect(handler, "guide-network-lines-api")
    if path == "/health" and method == "GET":
        return jresp(handler, 200, {"ok": True, "now": int(time.time())})

    # ======================== 弹窗公告（v1.28.22） ========================
    # 客户端每次打开网页/App 都会拉 /announcements 并弹窗；管理员在管理后台增删改。
    # 公开读、写需管理员；普通管理员只能改自己发布的，超管可改全部。
    if path == "/announcements" and method == "GET":
        items = cm_db.ann_list(limit=int(q.get("limit") or 20))
        out = [{
            "id": a["id"], "title": a["title"], "body": a["body"], "link": a["link"],
            "pinned": bool(a["pinned"]), "createdAt": a["createdAt"], "updatedAt": a["updatedAt"],
            "author": a.get("author_nickname") or a.get("author_username") or "",
        } for a in items]
        return jresp(handler, 200, {"items": out, "count": len(out)})

    if path == "/admin/announcements" and method == "GET":
        u = require_admin(handler)
        is_super = bool(u.get("is_super"))
        is_owner = bool(u.get("is_owner"))
        out = []
        for a in cm_db.ann_list(include_removed=True, limit=200):
            out.append({
                "id": a["id"], "title": a["title"], "body": a["body"], "link": a["link"],
                "pinned": bool(a["pinned"]), "removed": bool(a["removed"]),
                "createdAt": a["createdAt"], "updatedAt": a["updatedAt"],
                "authorId": a["user_id"],
                "author": a.get("author_nickname") or a.get("author_username") or "",
                # 权限：本人发布的 或 超管（前端据此置灰按钮，服务端仍会再校验一次）
                "canEdit": is_super or a["user_id"] == u["id"],
            })
        return jresp(handler, 200, {"items": out, "isSuper": is_super, "isOwner": is_owner})

    def _ann_writable(u, aid):
        """取公告并校验写权限：本人发布的 或 超管。"""
        a = cm_db.ann_get(aid)
        if not a:
            raise ApiError(404, "公告不存在")
        if not (u.get("is_super") or a["user_id"] == u["id"]):
            raise ApiError(403, "只能管理自己发布的公告")
        return a

    def _ann_payload(src):
        title = str((src or {}).get("title") or "").strip()
        body = str((src or {}).get("body") or "").strip()
        link = str((src or {}).get("link") or "").strip()
        if not title:
            raise ApiError(400, "请填写公告标题")
        if len(title) > 60:
            raise ApiError(400, "标题过长（最多 60 字）")
        if len(body) > 4000:
            raise ApiError(400, "正文过长（最多 4000 字）")
        if link and not re.match(r"^https?://", link):
            raise ApiError(400, "链接需以 http:// 或 https:// 开头")
        return title, body, link, 1 if (src or {}).get("pinned") else 0

    if path == "/announcements" and method == "POST":
        u = require_admin(handler)
        title, body, link, pinned = _ann_payload(body)
        aid = cm_db.ann_create(u["id"], title, body, link, pinned)
        log.info("公告发布 user=%s id=%s title=%s", u["id"], aid, title)
        return jresp(handler, 200, {"ok": True, "id": aid})

    m = re.fullmatch(r"/announcements/(\d+)", path)
    if m and method in ("PUT", "PATCH"):
        u = require_admin(handler)
        a = _ann_writable(u, int(m.group(1)))
        title, body_text, link, pinned = _ann_payload(body)
        cm_db.ann_update(a["id"], title=title, body=body_text, link=link, pinned=pinned)
        log.info("公告更新 user=%s id=%s", u["id"], a["id"])
        return jresp(handler, 200, {"ok": True})

    if m and method == "DELETE":
        u = require_admin(handler)
        a = _ann_writable(u, int(m.group(1)))
        cm_db.ann_update(a["id"], removed=1)
        log.info("公告移除 user=%s id=%s", u["id"], a["id"])
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/announcements/(\d+)/restore", path)
    if m and method == "POST":
        u = require_admin(handler)
        a = _ann_writable(u, int(m.group(1)))
        cm_db.ann_update(a["id"], removed=0)
        log.info("公告恢复 user=%s id=%s", u["id"], a["id"])
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/announcements/(\d+)/pin", path)
    if m and method == "POST":
        u = require_admin(handler)
        a = _ann_writable(u, int(m.group(1)))
        want = (body or {}).get("pinned")
        pinned = (not a["pinned"]) if want is None else bool(want)
        cm_db.ann_update(a["id"], pinned=pinned)
        return jresp(handler, 200, {"ok": True, "pinned": pinned})

    # ---- 首屏聚合（v1.28.3）----
    # 首页原先要发 4~6 条请求（me / daily / bind / recent），每条都要一次连接与
    # TLS 握手；这里在**服务端**并行取好一次返回。实测源站处理只要 2~5ms，瓶颈
    # 全在网络上，所以省下的是"连接与往返次数"而不是计算量。
    # 说明：只聚合服务端自身数据（DB/缓存），账号维度的 NCM 推荐仍由客户端单独取
    # （那是上游接口，放在这里会让整个首屏等上游）。单项失败只置空，不影响其它项。
    if path == "/bootstrap" and method == "GET":
        u = optional_user(handler)
        tasks = {"daily": lambda: _payload_daily(u)}
        if u:
            tasks.update({
                "me": lambda: _payload_me(u),
                "bind": lambda: _payload_bind(u),
                "recent": lambda: _payload_recent(u, 20),
            })
        out = _run_isolated(tasks)
        out["ts"] = int(time.time())
        return jresp(handler, 200, out)

    # ---- 认证 ----
    if path == "/auth/email/code" and method == "POST":
        """发送注册验证码：6 位、5 分钟有效、每邮箱 60s 冷却。"""
        email = str((body or {}).get("email") or "").strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "邮箱格式不正确")
        if not cm_mail.smtp_ready():
            raise ApiError(500, "邮件服务未配置，请联系管理员")
        if cm_db.email_taken(email):
            raise ApiError(409, "该邮箱已注册，请直接登录或换用其他邮箱")
        row = cm_db.get_email_code(email)
        now = int(time.time())
        if row and now - row["sent_at"] < 60:
            raise ApiError(429, f"发送太频繁，请 {60 - (now - row['sent_at'])} 秒后再试")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            cm_mail.send_code_email(email, code, 5)
        except Exception as e:  # noqa: BLE001
            log.warning("验证码发送失败 to=%s: %s", email, e)
            raise ApiError(502, "邮件发送失败，请稍后重试或检查邮箱地址")
        cm_db.save_email_code(email, code, 300)
        return jresp(handler, 200, {"ok": True, "ttl": 300})

    if path == "/auth/sms" and method == "GET":
        """短信通道信息：注册页手机验证的提示语由服务端给出（自建网关 / 网易云通道自动选择）。"""
        return jresp(handler, 200, {"mode": cm_sms.mode(), "hint": cm_sms.describe()})

    if path == "/auth/phone/code" and method == "POST":
        """发送注册短信验证码。

        限流三重：每号码 60s 冷却（DB 持久）→ 24h 上限 5 条 → 每 IP 1h 上限 10 条，
        防止接口被当作短信轰炸通道（网易云通道发的是真实短信）。
        """
        phone = norm_phone((body or {}).get("phone"))
        ctcode = re.sub(r"\D", "", str((body or {}).get("ctcode") or "86")) or "86"
        if not phone:
            raise ApiError(400, "手机号格式不正确")
        if cm_db.phone_taken(phone):
            raise ApiError(409, "该手机号已注册，请直接登录或换用其他号码")
        last, day, hour = cm_db.sms_quota_state(phone, ip)
        now = int(time.time())
        if last and now - last < SMS_COOLDOWN:
            raise ApiError(429, f"发送太频繁，请 {SMS_COOLDOWN - (now - last)} 秒后再试")
        if day >= SMS_PER_PHONE_DAY:
            raise ApiError(429, "该号码今日验证码次数已达上限，请明天再试")
        if hour >= SMS_PER_IP_HOUR:
            raise ApiError(429, "当前网络请求验证码过于频繁，请稍后再试")
        try:
            mode, code = cm_sms.send(phone, ctcode)
        except Exception as e:  # noqa: BLE001 上游/网关错误统一转可读提示
            log.warning("短信验证码发送失败 to=%s: %s", mask_phone(phone), e)
            raise ApiError(502, _friendly_sms_error(e))
        cm_db.save_phone_code(phone, code, 300, mode)
        cm_db.sms_log_add(phone, ip)
        return jresp(handler, 200, {"ok": True, "ttl": 300, "mode": mode, "hint": cm_sms.describe()})

    if path == "/auth/register" and method == "POST":
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        nickname = str(body.get("nickname") or "").strip()[:24] or username
        if not USERNAME_RE.match(username):
            raise ApiError(400, "用户名需 2~24 位字母/数字/下划线/中文")
        if not (6 <= len(password) <= 64):
            raise ApiError(400, "密码长度需 6~64 位")
        if cm_db.get_user_by_name(username):
            raise ApiError(409, "用户名已被占用")
        email = str(body.get("email") or "").strip().lower()
        email_code = str(body.get("emailCode") or "").strip()
        phone = norm_phone(body.get("phone"))
        phone_code = str(body.get("phoneCode") or "").strip()
        now = int(time.time())
        if phone or phone_code:
            # 手机验证路径
            if not phone or not phone_code:
                raise ApiError(400, "手机号与验证码需同时填写")
            if cm_db.phone_taken(phone):
                raise ApiError(409, "该手机号已注册，请直接登录")
            if email and cm_db.email_taken(email):
                raise ApiError(409, "该邮箱已注册，请直接登录")
            _check_phone_code(phone, phone_code, now)
        else:
            # 邮箱验证路径
            if not email or not email_code:
                raise ApiError(400, "注册需完成手机或邮箱验证")
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                raise ApiError(400, "邮箱格式不正确")
            if cm_db.email_taken(email):
                raise ApiError(409, "该邮箱已注册，请直接登录")
            _check_email_code(email, email_code, now)
        uid = cm_db.create_user(username, password, nickname, email, phone)
        _dev, _plat = device_label(handler, body)
        token = cm_db.issue_token(uid, _dev, _plat)
        cm_region.note(uid, cm_ncm_gateway.client_ip(handler))   # 注册即记录 IP 属地
        log.info("注册用户 uid=%s name=%s verify=%s ip=%s", uid, username, "phone" if phone else "email", ip)
        return jresp(handler, 200, {"token": token, "user": public_user(cm_db.get_user(uid))})

    if path.startswith("/auth/passkeys"):
        try:
            origin = handler.headers.get("Origin", "")
            if path == "/auth/passkeys/login/options" and method == "POST":
                return jresp(handler, 200, cm_passkeys.begin(origin))
            if path == "/auth/passkeys/login/verify" and method == "POST":
                dev, plat = device_label(handler, body)
                r = cm_passkeys.finish(origin, str(body.get("challengeToken") or ""), body.get("credential") or {}, device=dev, platform=plat)
                cm_region.note(r["uid"], ip)
                return jresp(handler, 200, {"token": r["token"], "user": public_user(cm_db.get_user(r["uid"]))})
            u = require_user(handler)
            if path == "/auth/passkeys" and method == "GET":
                return jresp(handler, 200, cm_passkeys.listing(u["id"]))
            if path == "/auth/passkeys/register/options" and method == "POST":
                return jresp(handler, 200, cm_passkeys.begin(origin, u["id"], u["_token"], str(body.get("password") or ""), str(body.get("factor") or "")))
            if path == "/auth/passkeys/register/verify" and method == "POST":
                return jresp(handler, 200, cm_passkeys.finish(origin, str(body.get("challengeToken") or ""), body.get("credential") or {}, u["id"], u["_token"], str(body.get("name") or "")))
            if path == "/auth/passkeys/delete" and method == "POST":
                return jresp(handler, 200, cm_passkeys.remove(u["id"], str(body.get("id") or ""), str(body.get("password") or ""), str(body.get("factor") or "")))
            raise ApiError(404, "接口不存在")
        except cm_passkeys.Error as e:
            raise ApiError(e.status, str(e))

    if path in ("/auth/security-question", "/auth/security-question/login"):
        try:
            if path == "/auth/security-question/login" and method == "POST":
                c = cm_2fa.complete(str(body.get("challengeToken") or ""), str(body.get("answer") or ""), method="security_question")
                u = cm_db.get_user(c["uid"])
                cm_region.note(u["id"], ip)
                return jresp(handler, 200, {"token": c["token"], "user": public_user(u)})
            u = require_user(handler)
            if path == "/auth/security-question" and method == "GET":
                state = cm_2fa.status(u["id"])
                return jresp(handler, 200, {"enabled": state["securityQuestionEnabled"], "question": state["securityQuestion"], "twoFactorEnabled": state["enabled"]})
            if path == "/auth/security-question" and method == "POST":
                result = cm_2fa.enable_question(u["id"], u["_token"], str(body.get("password") or ""), str(body.get("question") or ""), str(body.get("answer") or ""))
            elif path == "/auth/security-question" and method == "DELETE":
                result = cm_2fa.disable_question(u["id"], u["_token"], str(body.get("password") or ""), str(body.get("answer") or ""))
            else:
                raise ApiError(404, "接口不存在")
            return jresp(handler, 200, result)
        except cm_2fa.Error as e:
            raise ApiError(e.status, str(e))

    if path.startswith("/auth/2fa/"):
        try:
            if path == "/auth/2fa/login" and method == "POST":
                c = cm_2fa.complete(str(body.get("challengeToken") or ""), str(body.get("code") or "").strip())
                u = cm_db.get_user(c["uid"])
                token = c["token"]
                cm_region.note(u["id"], ip)
                return jresp(handler, 200, {"token": token, "user": public_user(u)})
            u = require_user(handler)
            if path == "/auth/2fa/status" and method == "GET":
                return jresp(handler, 200, cm_2fa.status(u["id"]))
            args = (u["id"], u["_token"])
            if path == "/auth/2fa/setup" and method == "POST":
                result = cm_2fa.setup(*args, str(body.get("password") or ""))
            elif path == "/auth/2fa/enable" and method == "POST":
                result = cm_2fa.enable(*args, str(body.get("code") or "").strip())
            elif path == "/auth/2fa/disable" and method == "POST":
                result = cm_2fa.disable(*args, str(body.get("password") or ""), str(body.get("code") or "").strip())
            else:
                raise ApiError(404, "接口不存在")
            return jresp(handler, 200, result)
        except cm_2fa.Error as e:
            raise ApiError(e.status, str(e))

    if path == "/auth/internal" and method == "POST":
        """内部登录渠道：共享单一「内部账户」，密码经 CM_INTERNAL_PASS 环境变量注入。"""
        pw = str((body or {}).get("password") or "")
        expect = os.environ.get("CM_INTERNAL_PASS", "")
        if not expect:
            raise ApiError(503, "内部登录未启用")
        if pw != expect:
            raise ApiError(401, "内部密码错误")
        u = cm_db.get_user_by_name("__internal__")
        if not u:
            uid = cm_db.create_user("__internal__", secrets.token_hex(16), "内部账户", "__internal__@local")
            u = cm_db.get_user(uid)
        _dev, _plat = device_label(handler, body)
        try:
            pending = cm_2fa.challenge(u["id"], _dev, _plat)
        except cm_2fa.Error as e:
            raise ApiError(e.status, str(e))
        if pending.get("challengeToken"):
            return jresp(handler, 200, pending)
        token = pending["token"]
        log.info("内部登录 uid=%s", u["id"])
        return jresp(handler, 200, {"token": token, "user": public_user(u)})

    if path == "/auth/login" and method == "POST":
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        try:
            u = cm_db.verify_login(username, password)
        except PermissionError as e:
            raise ApiError(403, str(e))
        if not u:
            raise ApiError(401, "用户名或密码错误")
        _dev, _plat = device_label(handler, body)
        try:
            pending = cm_2fa.challenge(u["id"], _dev, _plat)
        except cm_2fa.Error as e:
            raise ApiError(e.status, str(e))
        if pending.get("challengeToken"):
            return jresp(handler, 200, pending)
        token = pending["token"]
        cm_region.note(u["id"], cm_ncm_gateway.client_ip(handler))   # 登录即记录 IP 属地
        return jresp(handler, 200, {"token": token, "user": public_user(u)})

    # ---- 邮箱验证码登录（v1.28.31）：发码要求邮箱**已注册**（与注册码方向相反），
    # 存储键 login:<email> 与注册码命名空间隔离；限流 = 每邮箱 60s（DB 持久）
    # + 每 IP 每小时 10 条（进程内），防被当邮件轰炸通道。
    if path == "/auth/login/email/code" and method == "POST":
        email = str((body or {}).get("email") or "").strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "邮箱格式不正确")
        if not cm_db.get_user_by_email(email):
            raise ApiError(404, "该邮箱未注册，请先注册或在设置中绑定邮箱")
        if not cm_mail.smtp_ready():
            raise ApiError(500, "邮件服务未配置，请联系管理员")
        now = int(time.time())
        cutoff = now - 3600
        _email_ip_hour[ip] = [t for t in _email_ip_hour.get(ip, []) if t > cutoff]
        if len(_email_ip_hour[ip]) >= 10:
            raise ApiError(429, "当前网络请求验证码过于频繁，请稍后再试")
        k = f"login:{email}"
        row = cm_db.get_email_code(k)
        if row and now - row["sent_at"] < 60:
            raise ApiError(429, f"发送太频繁，请 {60 - (now - row['sent_at'])} 秒后再试")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            cm_mail.send_code_email(email, code, 5, "登录")
        except Exception as e:  # noqa: BLE001
            log.warning("登录验证码发送失败 to=%s: %s", email, e)
            raise ApiError(502, "邮件发送失败，请稍后重试")
        cm_db.save_email_code(k, code, 300)
        _email_ip_hour.setdefault(ip, []).append(now)
        log.info("发送登录验证码 email=%s uid=%s ip=%s", email, cm_db.get_user_by_email(email)["id"], ip)
        return jresp(handler, 200, {"ok": True, "ttl": 300})

    if path == "/auth/login/email" and method == "POST":
        email = str((body or {}).get("email") or "").strip().lower()
        code = str(body.get("code") or "").strip()
        if not email or not code:
            raise ApiError(400, "请填写邮箱与验证码")
        _check_email_code(email, code, int(time.time()), key=f"login:{email}")
        u = cm_db.get_user_by_email(email)
        if not u:
            raise ApiError(404, "该邮箱未注册")
        if u.get("disabled"):
            raise ApiError(403, "账号已被禁用，请联系管理员")
        _dev, _plat = device_label(handler, body)
        try:
            pending = cm_2fa.challenge(u["id"], _dev, _plat)
        except cm_2fa.Error as e:
            raise ApiError(e.status, str(e))
        if pending.get("challengeToken"):
            return jresp(handler, 200, pending)
        token = pending["token"]
        cm_region.note(u["id"], cm_ncm_gateway.client_ip(handler))   # 登录即记录 IP 属地
        log.info("邮箱验证码登录 uid=%s ip=%s", u["id"], ip)
        return jresp(handler, 200, {"token": token, "user": public_user(u)})

    # ---- 邮箱验证码找回密码（v1.28.76）----
    # 未登录也能用：邮箱所有权由验证码证明；重置成功后吊销该账号**全部**会话
    # 与通行证授权（密码已变，旧 token 不应继续有效）。验证码存 reset:<email>，
    # 与注册码/登录码/绑定码命名空间隔离。
    if path == "/auth/password/code" and method == "POST":
        email = str((body or {}).get("email") or "").strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "邮箱格式不正确")
        u = cm_db.get_user_by_email(email)
        if not u:
            raise ApiError(404, "该邮箱未注册，请先注册或在设置中绑定邮箱")
        if u.get("is_bot"):
            raise ApiError(403, "系统账号不支持找回密码")
        if u.get("disabled"):
            raise ApiError(403, "账号已被禁用，请联系管理员")
        if not cm_mail.smtp_ready():
            raise ApiError(500, "邮件服务未配置，请联系管理员")
        now = int(time.time())
        _email_ip_budget(ip, now)
        k = _password_code_key(email)
        row = cm_db.get_email_code(k)
        if row and now - row["sent_at"] < 60:
            raise ApiError(429, f"发送太频繁，请 {60 - (now - row['sent_at'])} 秒后再试")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            cm_mail.send_code_email(email, code, 5, "重置密码")
        except Exception as e:  # noqa: BLE001
            log.warning("找回密码验证码发送失败 to=%s: %s", email, e)
            raise ApiError(502, "邮件发送失败，请稍后重试")
        cm_db.save_email_code(k, code, 300)
        _email_ip_hour.setdefault(ip, []).append(now)
        log.info("发送找回密码验证码 email=%s uid=%s ip=%s", email, u["id"], ip)
        return jresp(handler, 200, {"ok": True, "ttl": 300})

    if path == "/auth/password/reset" and method == "POST":
        email = str((body or {}).get("email") or "").strip().lower()
        code = str((body or {}).get("code") or "").strip()
        new_pw = str((body or {}).get("newPassword") or "")
        if not email or not code:
            raise ApiError(400, "请填写邮箱与验证码")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "邮箱格式不正确")
        if not (6 <= len(new_pw) <= 64):
            raise ApiError(400, "新密码长度需 6~64 位")
        u = cm_db.get_user_by_email(email)
        if not u:
            raise ApiError(404, "该邮箱未注册")
        if u.get("is_bot"):
            raise ApiError(403, "系统账号不支持找回密码")
        if u.get("disabled"):
            raise ApiError(403, "账号已被禁用，请联系管理员")
        _check_email_code(email, code, int(time.time()), key=_password_code_key(email))
        cm_db.set_password(u["id"], new_pw)
        cm_db.revoke_token(u["id"])       # 全部设备下线 + 通行证授权撤销
        log.info("密码重置成功 uid=%s ip=%s", u["id"], ip)
        return jresp(handler, 200, {"ok": True, "username": u["username"],
                                    "nickname": u["nickname"]})

    if path == "/auth/logout" and method == "POST":
        u = require_user(handler)
        cm_db.revoke_token(u["id"], u.get("_token"))     # 只登出当前设备
        return jresp(handler, 200, {"ok": True})

    if path == "/auth/sessions" and method == "GET":
        """在线设备列表；max=null 表示数量不限，超过 5 台时客户端显示风险提示。"""
        u = require_user(handler)
        return jresp(handler, 200, {"max": None,
                                    "sessions": cm_db.list_sessions(u["id"], u.get("_token"))})

    m = re.fullmatch(r"/auth/sessions/([0-9a-f]{8,64})", path)
    if m and method == "DELETE":
        u = require_user(handler)
        if not cm_db.revoke_session(u["id"], m.group(1)):
            raise ApiError(404, "设备不存在或已下线")
        return jresp(handler, 200, {"ok": True})

    if path == "/auth/sessions/others" and method == "DELETE":
        """退出其他所有设备（保留当前）。"""
        u = require_user(handler)
        cur = u.get("_token")
        removed = 0
        for s in cm_db.list_sessions(u["id"], cur):
            if not s["current"] and cm_db.revoke_session(u["id"], s["id"]):
                removed += 1
        return jresp(handler, 200, {"ok": True, "removed": removed})

    if path == "/auth/me" and method == "GET":
        return jresp(handler, 200, _payload_me(require_user(handler)))

    # ============================ CurrentStation 通行证 ============================
    # 统一登录平台（OAuth 2.0 授权码 + PKCE）。与 /auth（账号本体：注册/登录/会话/设备）
    # 分离：账号体系一行未改，现有 App 与网页照旧；第三方产品接这一节。
    # 端点：meta / docs / apps / authorize / token / userinfo / introspect / revoke / grants / events

    # ---- 开发者平台：应用自助登记/管理（普通用户管自己的，管理员管所有）----
    MAX_APPS_PER_USER = 5          # 每个账号可登记的应用数上限（防刷）
    MAX_REDIRECTS = 8

    def _check_redirects(rs):
        """回调地址校验：必须是 http(s)、非本机必须 https、不允许带 fragment、不允许通配。"""
        if not isinstance(rs, list):
            raise ApiError(400, "redirects 必须是数组")
        out = []
        for r in rs:
            r = str(r or "").strip()
            if not r:
                continue
            if "*" in r:
                raise ApiError(400, "回调地址不支持通配符，请填写完整地址")
            sp = urlparse(r)
            if sp.scheme not in ("http", "https") or not sp.netloc or sp.fragment:
                raise ApiError(400, f"回调地址不合法：{r}")
            if sp.scheme == "http" and sp.hostname not in ("localhost", "127.0.0.1", "::1"):
                raise ApiError(400, f"回调地址必须用 https（本机调试除外）：{r}")
            if len(out) < MAX_REDIRECTS:
                out.append(r)
        return out

    def _app_owned(u, key, write=True):
        """取应用并校验权限：所有者本人或管理员。"""
        app = cm_db.passport_app_get(key)
        if not app:
            raise ApiError(404, "应用不存在")
        is_admin = bool(u.get("is_admin") or u.get("is_super"))
        if write and not is_admin and app["owner_uid"] != u["id"]:
            raise ApiError(403, "只能管理自己登记的应用")
        return app, is_admin

    def _app_json(a, with_grants=True):
        return {"clientId": a["key"], "name": a["name"], "scopes": a["scopes"],
                "redirects": json.loads(a["redirects"] or "[]"), "homepage": a["homepage"],
                "logo": a["logo"], "public": not a["secret_hash"],
                "firstParty": bool(a["first_party"]), "disabled": bool(a["disabled"]),
                "ownerUid": a["owner_uid"], "createdAt": a["created_at"],
                "mine": True,
                "grants": len(cm_db.passport_grant_list_app(a["key"])) if with_grants else 0}
    if path in ("/passport/meta", "/passport/.well-known/openid-configuration") and method == "GET":
        """平台元信息：端点、scope 目录、令牌有效期（第三方可据此自动配置）。"""
        base = base_url(handler)
        pbase = f"{base}/cm/passport"
        apps = [a for a in cm_db.passport_app_list() if not a["disabled"]]
        return jresp(handler, 200, {
            "platform": "CurrentStation 通行证",
            "protocol": "OAuth 2.0 (authorization_code + PKCE)",
            "version": "1.0",
            "issuer": f"{base}/cm",
            "endpoints": {
                "authorize": f"{pbase}/authorize",
                "token": f"{pbase}/token",
                "userinfo": f"{pbase}/userinfo",
                "introspect": f"{pbase}/introspect",
                "revoke": f"{pbase}/revoke",
                "grants": f"{pbase}/grants",
                "apps": f"{pbase}/apps",
                "docs": f"{pbase}/docs",
            },
            "scopes": [{"scope": k, "label": v["label"], "desc": v["desc"], "required": v["required"]}
                       for k, v in cm_passport.SCOPES.items()],
            "scope_default": cm_passport.DEFAULT_SCOPE,
            "grant_types": list(cm_passport.GRANT_TYPES),
            "code_challenge_methods": ["S256"],
            "token_ttl": {"code": cm_passport.CODE_TTL, "access": cm_passport.ACCESS_TTL,
                          "refresh": cm_passport.REFRESH_TTL},
            "first_party_apps": [{"client_id": a["key"], "name": a["name"]} for a in apps if a["first_party"]],
            "accounts_endpoint": f"{base}/cm/auth/login",
        })

    if path in ("/station", "/station/", "/console", "/console/") and method == "GET":
        """CurrentStation 控制台：独立于 CurrentMusic SPA 的统一账户与开发者入口。"""
        fp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "station.html")
        if not os.path.isfile(fp):
            raise ApiError(404, "CurrentStation 控制台页面缺失")
        with open(fp, "r", encoding="utf-8") as f:
            html = f.read()
        return hresp(handler, 200, html.replace("{{BASE}}", base_url(handler)))

    if path == "/station/api-catalog" and method == "GET":
        """CurrentStation 控制台使用的统一接口目录。

        NCM 部分来自登记表，确保文档不会展示被网关拒绝的路径；自有部分按公开路由族列出。
        """
        base = base_url(handler)
        own = [
            ("GET", "/health", "公开", "服务健康检查"),
            ("GET", "/network/lines", "公开", "主站及全部 CDN 镜像线路与服务端 HTTPS 测速结果；measure=0 仅目录；结果缓存 60 秒，perspective=server，不代表用户网络延迟。详细文档 /api-docs/reference/guide-network-lines-api/"),
            ("GET", "/network/probe", "公开", "浏览器线路测速探针：返回 service=CurrentMusic，支持 CORS；页面 /app/auto 从用户设备直接测量 HTTPS 请求耗时"),
            ("GET", "/network/docs", "公开", "兼容入口，302 跳转至 /api-docs/reference/guide-network-lines-api/"),
            ("GET", "/bootstrap", "可选登录", "控制台/客户端首屏聚合数据"),
            ("POST", "/auth/register", "公开", "注册 Current 账户"),
            ("POST", "/auth/login/email/code", "公开", "发送**登录**邮箱验证码（要求邮箱已注册；60s 冷却 + 每 IP 每小时 10 条）"),
            ("POST", "/auth/login/email", "公开", "邮箱验证码登录 {email, code}，开启 2FA 时返回验证挑战，否则返回 {token, user}（验证码与注册码命名空间隔离）"),
            ("POST", "/auth/password/code", "公开", "发送**找回密码**邮箱验证码（要求邮箱已注册；reset: 命名空间；60s 冷却 + 每 IP 每小时 10 条）"),
            ("POST", "/auth/password/reset", "公开", "邮箱验证码重置密码 {email, code, newPassword}；成功后吊销该账号全部会话与通行证授权"),
            ("POST", "/profile/email/code", "Bearer", "发送**绑定/换绑邮箱**验证码（新邮箱不得属于其他账号；60s 冷却 + IP 限流）"),
            ("PUT", "/profile/email", "Bearer", "绑定/换绑邮箱 {email, code}（验证码证明所有权；bind: 命名空间隔离）"),
            ("POST", "/profile/password/code", "Bearer", "向当前账号绑定邮箱发送**修改密码**验证码（未绑定邮箱返回 400；与找回密码共用 reset: 命名空间）"),
            ("PUT", "/profile/password", "Bearer", "修改密码：{oldPassword,newPassword} 或 {emailCode,newPassword}；邮箱验证码方式保留下线其他设备"),
            ('GET', '/auth/passkeys', 'Bearer', '列出本账号通行密钥（不返回公钥）；各 HTTPS 域名独立绑定'),
            ('POST', '/auth/passkeys/register/options', 'Bearer', '绑定选项 {password,factor}；开启 2FA/密保须验证当前因素；挑战绑定会话和 Origin，5 分钟单次有效'),
            ('POST', '/auth/passkeys/register/verify', 'Bearer', '完成绑定 {challengeToken,credential,name}；强制用户验证和可发现凭据'),
            ('POST', '/auth/passkeys/login/options', '公开', '通行密钥登录选项；强制用户验证'),
            ('POST', '/auth/passkeys/login/verify', '公开', '{challengeToken,credential,device,platform}；验签成功直接返回 {token,user}，无需额外 2FA 或密保'),
            ('POST', '/auth/passkeys/delete', 'Bearer', '撤销 {id,password,factor}；须密码及已启用的二次验证'),
            ("GET", "/auth/security-question", "Bearer", "登录密保状态：{enabled, question, twoFactorEnabled}；不返回答案或哈希"),
            ("POST", "/auth/security-question", "Bearer", "开启密保 {password,question,answer}；与验证器 2FA 互斥；验证当前密码并下线其他设备"),
            ("DELETE", "/auth/security-question", "Bearer", "关闭密保 {password,answer}；需当前密码和原答案，下线其他设备"),
            ("POST", "/auth/security-question/login", "公开", "完成密保登录 {challengeToken,answer}；返回 {token,user}，5 分钟有效且单次消费"),
            ("GET", "/auth/2fa/status", "Bearer", "两步验证状态及剩余恢复码数量"),
            ("POST", "/auth/2fa/setup", "Bearer", "校验当前密码 {password}，返回待绑定密钥 secret 和 otpauth uri（10 分钟，会话绑定）"),
            ("POST", "/auth/2fa/enable", "Bearer", "校验 {code} 后开启 TOTP；返回仅显示一次的 10 枚 recoveryCodes，下线其他设备"),
            ("POST", "/auth/2fa/disable", "Bearer", "{password, code}：当前密码 + 验证器验证码或恢复码关闭两步验证，下线其他设备"),
            ("POST", "/auth/2fa/login", "公开", "{challengeToken, code}：完成第二步登录，返回 {token, user}；5 分钟有效，失败每账号 5 次/5 分钟"),
            ("POST", "/auth/login", "公开", "登录 Current 账户；开启验证器 2FA 或密保时先返回验证挑战（requires2FA 或 requiresSecurityQuestion、challengeToken、expiresIn），不会签发会话"),
            ("POST", "/auth/logout", "Bearer", "退出当前设备并撤销会话"),
            ("GET", "/auth/me", "Bearer", "当前账户资料与统计"),
            ("GET", "/auth/sessions", "Bearer", "在线设备列表 {max:null,sessions}；数量不限，超过 5 台时客户端提示风险"),
            ("DELETE", "/auth/sessions/{id}", "Bearer", "下线指定设备"),
            ("DELETE", "/auth/sessions/others", "Bearer", "下线其他设备"),
            ("GET", "/announcements", "公开", "站内公告（客户端每次打开拉取并弹窗，置顶在前）"),
            ("GET", "/ncm/lyric", "公开", "歌词归一化：{lines:[{t,txt,trans,roma,w?,words?,wSynth?}],isYrc,source,wordLevel}；t/w 单位为毫秒，w=[起始,字/词]；官方 YRC → LDDC 逐字 → 按行时长估算（wSynth）"),
            ("GET", "/admin/announcements", "管理员", "公告管理列表（含已移除；带 canEdit 权限标记）"),
            ("GET", "/admin/overview", "管理员", "管理台概览：总量 + 近30天注册/近14天播放序列 + 角色计数"),
            ("GET", "/admin/clients", "管理员", "客户端版本：CurrentMusic 与 CurrentMusicX 的版本/大小/发布时间/更新说明/历史/下载数"),
            ("GET", "/admin/traffic", "管理员", "站点出站流量（需 CM_TRAFFIC_LOG；服务端 20s 缓存）"),
            ("GET", "/admin/users", "管理员", "用户搜索/分页/排序 {query,limit,offset,sort}；sort=reg/reg_asc/name/active/sessions/likes/plays/role"),
            ("GET", "/admin/sessions", "管理员", "全部在线设备（最多 100 台）"),
            ("POST", "/announcements", "管理员", "发布公告（标题必填，正文支持 Markdown）"),
            ("PUT", "/announcements/{id}", "管理员本人/超管", "编辑公告（普通管理员仅限自己发布的）"),
            ("DELETE", "/announcements/{id}", "管理员本人/超管", "移除公告（软删，公开接口不再下发）"),
            ("POST", "/announcements/{id}/pin", "管理员本人/超管", "置顶 / 取消置顶"),
            ("POST", "/announcements/{id}/restore", "管理员本人/超管", "恢复已移除的公告"),
            ("POST", "/admin/users/{id}/title", "管理员", "设置 / 清空用户头衔（''=清空；普通管理员不能改超管）"),
            ("POST", "/admin/users/{id}/super", "超管", "设置 / 取消超级管理员（仅超管/站长，至少保留一位）"),
            ("POST", "/admin/users/{id}/owner", "站长", "设置 / 取消站长（最高角色，仅站长，至少保留一位）"),
            ("GET", "/users/square", "公开", "用户发现广场（含 ipRegion IP 属地：省份/国家，空串=未知）"),
            ("GET", "/ncmbind", "Bearer", "网易云绑定状态（bound/profile/stale/lastSync）"),
            ("GET", "/ncmbind/session", "Bearer", "**第三方客户端用**：一次返回 bound/valid/profile/note（不暴露 cookie，登录态由服务端代理）"),
            ("POST", "/ncmbind/import", "Bearer", "同步本机网易云登录至当前账号；服务端验证身份，不返回 cookie；详见第三方登录态同步专题"),
            ("GET", "/ncmbind/live", "Bearer", "网易云登录态诊断（上游 /login/status 权威判据）"),
            ("POST", "/ncmbind/qr/key", "Bearer", "二维码绑定-1：取 key"),
            ("GET", "/ncmbind/qr/img", "Bearer", "二维码绑定-2：key→base64 二维码图片（?key=）"),
            ("GET", "/ncmbind/qr/check", "Bearer", "二维码绑定-3：轮询扫码状态（801 待扫 / 802 已扫 / 803 成功绑定 / 800 过期）"),
            ("POST", "/ncmbind/phone/code", "Bearer", "手机绑定-1：发送验证码 {phone, ctcode?}（60s 冷却）"),
            ("POST", "/ncmbind/phone/login", "Bearer", "手机绑定-2：验证码登录并绑定 {phone, captcha, ctcode?}"),
            ("POST", "/ncmbind/refresh", "Bearer", "刷新网易云登录态（cookie 续期，免重扫）"),
            ("DELETE", "/ncmbind", "Bearer", "解绑网易云账号（已导入歌单保留为本地快照）"),
            ("POST", "/ncmbind/sync", "Bearer", "把网易云歌单同步为本站歌单快照"),
            ("POST", "/artists/{id}/follow", "Bearer", "关注/取关网易云歌手 {on}；写操作透传可信 RealIP"),
            ("POST|DELETE", "/ncmbind/comment/{ncmId}", "Bearer", "发布/回复评论 {content,commentId?} 或删除 {commentId}；透传可信 RealIP（影响 IP 属地/风控）"),
            ("POST", "/ncmbind/comment-like/{ncmId}", "Bearer", "评论点赞/取消 {commentId,like}；透传可信 RealIP"),
            ("GET", "/chat/messages", "公开", "公共聊天室：最近消息（含 atts 引用卡片；?before=<id> 向更早翻页，?limit=1~50）"),
            ("POST", "/chat/messages", "Bearer", "发送消息 {content≤500字, image?: 图片文件名, mentions?: [@用户id], atts?: [{type: song|album|artist|playlist, id, name, sub?, pic?}]≤5}（1.5s 频控）。**@CurrentMusicAI 可提问（卡片可选）；按用户保存近 6 轮上下文，服务端异步联网检索后以 AI 账号回复：先发空消息占位，再经 /chat/live 的 edit 事件流式更新（streaming=true），最终内容为 Markdown，可带 ≤3 张 atts 卡片；消息带 image 时图片会作为视觉输入发送给 AI**"),
            ("DELETE", "/chat/messages/{id}", "Bearer", "删除消息（本人或管理员/超管/站长，软删）"),
            ("POST", "/chat/image", "Bearer", "上传聊天图片 {file: base64, filename, contentType}（魔法字节校验，≤1.5MB，5s 频控）"),
            ("GET", "/chat/image/{file}", "公开", "聊天图片直链"),
            ("GET", "/chat/members", "公开", "聊天成员：?q= 实时搜索昵称/用户名（@ 提及选择器，最多 20，前缀命中优先；无 q 返回近期活跃；尊重广场公开开关，AI 账号始终可搜到）"),
            ("GET", "/chat/live", "公开", "聊天实时流：?sse=1 走 SSE（message/delete/edit 事件，id=seq 断线续传；edit.payload={id,content,atts,streaming}，AI 流式回答用同一 id 反复更新）；不带则返回 JSON 增量"),
            ("POST", "/ai/live", "Bearer", "播放页「问AI」：SSE（start/delta/done/error）流式回答 {question≤500字, song:{type:'song',id,name,sub?,pic?}, reset?:bool}；delta.text 为累计文本；scope=player 与公共 Chat 隔离，reset=true 先清空播放页上下文"),
            ("GET", "/users/{id}/profile", "公开", "公开用户主页（user.ipRegion = IP 属地，省份/国家，空串=未知）"),
            ("GET", "/posts", "可选登录", "发现动态列表"),
            ("POST", "/posts", "Bearer", "发布动态"),
            ("POST", "/posts/{id}/like", "Bearer", "点赞动态"),
            ("GET", "/plays/recent", "Bearer", "最近播放"),
            ("POST", "/plays/{ncmId}", "Bearer", "记录播放与收听时长；已绑定网易云时异步同步听歌历史（startplay + 满60s 写 play）"),
            ("GET", "/songs/status", "可选登录", "歌曲列表状态：liked/faved 为本地状态，counts 为本地计数，ncmCounts 为网易云红心数"),
            ("GET", "/likes/count", "公开", "批量点赞数：counts 本地、ncmCounts 网易云红心数"),
            ("POST", "/likes/{ncmId}", "Bearer", "CurrentMusic 自建红心 toggle {meta}，返回 {on,count}（本地计数）"),
            ("POST", "/ncmbind/like/{ncmId}", "Bearer", "网易云红心/取消红心 {like, meta}，返回 {liked,count}（网易云红心数）；写操作透传可信 RealIP"),
            ("GET", "/daily", "可选登录", "每日推荐"),
            ("GET", "/ncm/search", "公开", "网易云搜索代理；type=lyric 按歌词搜索（1006），songs 含命中行及前后文 lyric/lyricContext，分页使用 totals.song/hasMore.song；服务端等待并自动重试补全；失败通过 lyricContextStatus 明示，原命中单句仅在 lyricMatch。详见 /api-docs/reference/guide-search-lyrics-api/"),
            ("GET", "/ncm/song/url", "Bearer", "播放地址解析（**仅限注册用户**；level / maxBr 码率上限 / refresh 卡顿换线 / alts 候选边缘；返回 host 与耗时诊断）"),
            ("GET", "/ncm/song/detail", "公开", "歌曲详情（ids=逗号分隔，最多 100；分享落地页与客户端使用）"),
            ("GET", "/share/song/{id}", "公开", "歌曲分享元数据（name/artists/album/pic/duration/url/text/image；无需登录）"),
            ("GET", "/share/song/{id}/image", "公开", "歌曲分享图（1080×1440 JPEG，封面取色 + 二维码）"),
            ("GET", "/share/playlist/{id}", "公开", "网易云歌单分享元数据（名称/创建者/曲目数/url/text/image）"),
            ("GET", "/share/local-playlist/{id}", "公开", "CurrentMusic 自建歌单分享元数据"),
            ("GET", "/share/artist/{id}", "公开", "歌手分享元数据（名称/别名/作品数/url/text/image）"),
            ("GET", "/share/album/{id}", "公开", "专辑分享元数据（名称/歌手/发行信息/url/text/image）"),
            ("GET", "/share/{type}/{id}/image", "公开", "歌单/歌手/专辑分享图（与服务端歌曲分享图同一版式）"),
            ("GET", "/roaming/catalog", "Bearer", "私人漫游模式/场景目录（默认、熟悉、探索、拼图 + 场景）"),
            ("POST", "/roaming/songs", "Bearer+网易云绑定", "{mode,subMode?,limit?,excludeIds?} 取私人漫游推荐歌曲（账号态，不缓存）"),
            ("POST", "/roaming/trash", "Bearer+网易云绑定", "{id} 将歌曲移入网易云私人漫游垃圾桶"),
            ("POST", "/ncm/song/url/feedback", "公开", "播放卡顿上报（event=stall|ok，服务端据此在换线时避开问题 CDN 边缘）"),
            ("GET", "/ncm/song/url/health", "公开", "CDN 边缘健康度与音质档位策略（诊断用）"),
            ("GET", "/ncm/{path}", "按接口登记", "网易云接口代理（见网易云接口清单）。**音源族接口**（/song/url、/mv/url、/video/url、/song/cloud/download、/voice/detail）自 v1.28.33 起强制登录；**T2/T3 写操作**自 v1.28.65 起透传可信 RealIP"),
            ("GET", "/passport/meta", "公开", "通行证元信息与发现文档"),
            ("GET", "/passport/docs", "公开", "兼容入口，302 跳转至 /api-docs/reference/guide-passport-api/"),
            ("GET|POST", "/passport/apps", "Bearer", "创建或列出应用"),
            ("PUT|DELETE", "/passport/apps/{client_id}", "Bearer", "编辑、停用应用"),
            ("POST", "/passport/apps/{client_id}/secret", "Bearer", "轮换应用密钥"),
            ("GET|POST", "/passport/authorize", "用户会话", "授权同意页与批准"),
            ("POST", "/passport/token", "客户端", "授权码、刷新、客户端凭据换令牌"),
            ("GET", "/passport/userinfo", "Bearer", "读取被授权账户信息"),
            ("POST", "/passport/introspect", "客户端", "校验令牌"),
            ("POST", "/passport/revoke", "客户端/Bearer", "撤销令牌"),
            ("GET", "/passport/grants", "Bearer", "已授权应用列表"),
            ("DELETE", "/passport/grants/{id}", "Bearer", "解除应用授权"),
        ]
        own_out = [{"method": m, "path": p, "auth": a, "title": t,
                    "url": f"{base}/cm{p}"} for m, p, a, t in own]
        tier_label = {0: "公开只读", 1: "绑定账号只读", 2: "绑定账号写入", 3: "敏感接口"}
        ncm_out = []
        for p, (tier, ttl, phase) in sorted(cm_ncm_registry.REGISTRY.items()):
            if p == "/lyric":          # 已由上面的归一化 GET /ncm/lyric 提供，避免同路径两份说明
                continue
            ncm_out.append({"method": "GET/POST", "path": "/ncm" + p,
                            "auth": tier_label.get(tier, "按登记表"), "title": "网易云接口代理",
                            "tier": tier, "cacheSeconds": ttl, "phase": phase,
                            "url": f"{base}/cm/ncm{p}",
                            "upstream": f"{base}/cm/ncm{p}"})
        return jresp(handler, 200, {"version": "1.0", "generatedAt": int(time.time()),
                                    "sources": {"netease": f"{base}/docs",
                                                "backend": f"{base}/cm"},
                                    "groups": [{"id": "backend", "title": "CurrentMusic 自有后端", "items": own_out},
                                               {"id": "netease", "title": "网易云音乐侧（经 CurrentMusic 代理）", "items": ncm_out}]})

    if path == "/developer" and method == "GET":
        """CurrentDeveloper 开发者平台：独立页面（不依赖 /app 音乐客户端，自己管会话）。

        对外地址 https://<host>/developer（nginx 直通到后端）或 /cm/developer（经 /cm 前缀）。
        自包含单文件：无需构建、无外部依赖；登录态存在 csdev.token（与 CurrentMusic 的
        cm.token 完全分开），因此它是「通行证」的开发者入口，而不是音乐客户端的功能页。
        """
        fp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "developer.html")
        if not os.path.isfile(fp):
            raise ApiError(404, "开发者平台页面缺失")
        with open(fp, "r", encoding="utf-8") as f:
            html = f.read()
        return hresp(handler, 200, html.replace("{{BASE}}", base_url(handler)))

    if path in ("/passport/docs", "/passport/docs/") and method == "GET":
        return docs_redirect(handler, "guide-passport-api")

    # ---- 应用登记：CurrentDeveloper 开发者平台（任何登录用户都可自助接入）----
    if path == "/passport/apps" and method == "POST":
        u = require_user(handler)
        is_admin = bool(u.get("is_admin") or u.get("is_super"))
        b = body or {}
        mine = [a for a in cm_db.passport_app_list() if a["owner_uid"] == u["id"]]
        if not is_admin and len(mine) >= MAX_APPS_PER_USER:
            raise ApiError(429, f"每个账号最多登记 {MAX_APPS_PER_USER} 个应用，"
                                f"如需更多请联系管理员")
        name = str(b.get("name") or "").strip()
        if not name:
            raise ApiError(400, "请填写应用名称")
        if len(name) > 60:
            raise ApiError(400, "应用名称过长（最多 60 字）")
        redirects = _check_redirects(b.get("redirects") or [])
        if not redirects:
            raise ApiError(400, "请至少填写一个回调地址（redirect_uri）")
        scopes = cm_passport.parse_scope(b.get("scopes") or cm_passport.DEFAULT_SCOPE)
        is_public = bool(b.get("public"))
        key = cm_passport.new_client_id()
        secret = "" if is_public else cm_passport.new_client_secret()
        cm_db.passport_app_create(
            key, name, cm_passport.hash_token(secret) if secret else "", redirects, scopes,
            owner_uid=u["id"], homepage=str(b.get("homepage") or "")[:300],
            logo=str(b.get("logo") or "")[:300],
            first_party=1 if (is_admin and b.get("firstParty")) else 0,
        )
        cm_db.passport_event("app.create", key, u["id"], ip,
                             handler.headers.get("User-Agent", ""), f"name={name} public={is_public}")
        return jresp(handler, 201, {
            "clientId": key, "clientSecret": secret,
            "name": name, "redirects": redirects, "scopes": scopes, "public": is_public,
            "note": "clientSecret 只在创建时返回一次，请立即保存到服务端环境变量"
                    if secret else "公开客户端：不需要密钥，必须使用 PKCE",
        })

    if path == "/passport/apps" and method == "GET":
        u = require_user(handler)
        is_admin = bool(u.get("is_admin") or u.get("is_super"))
        want_all = q.get("all") in ("1", "true") and is_admin
        out = []
        for a in cm_db.passport_app_list():
            if not is_admin and a["owner_uid"] != u["id"]:
                continue
            if is_admin and not want_all and a["owner_uid"] != u["id"]:
                # 管理员默认也只看自己的；要看全部传 ?all=1（面板里有「全部应用」开关）
                continue
            item = _app_json(a)
            item["mine"] = a["owner_uid"] == u["id"]
            out.append(item)
        return jresp(handler, 200, {
            "apps": out,
            "quota": {"max": MAX_APPS_PER_USER, "used": len([a for a in cm_db.passport_app_list()
                                                             if a["owner_uid"] == u["id"]]),
                      "admin": is_admin},
        })

    m = re.fullmatch(r"/passport/apps/([A-Za-z0-9_\-]{4,64})", path)
    if m and method in ("PATCH", "PUT"):
        u = require_user(handler)
        app, is_admin = _app_owned(u, m.group(1))
        fields = {}
        new_secret = ""
        b = body or {}
        if "name" in b:
            fields["name"] = str(b["name"])[:60]
        if "homepage" in b:
            fields["homepage"] = str(b["homepage"])[:300]
        if "logo" in b:
            fields["logo"] = str(b["logo"])[:300]
        if "scopes" in b:
            fields["scopes"] = cm_passport.parse_scope(b["scopes"])
        if "redirects" in b:
            rs = _check_redirects(b["redirects"] or [])
            if not rs:
                raise ApiError(400, "至少保留一个回调地址")
            fields["redirects"] = rs
        if "disabled" in b:
            fields["disabled"] = bool(b["disabled"])
        if "firstParty" in b and is_admin:
            fields["first_party"] = bool(b["firstParty"])
        # 公开 ↔ 机密：切到机密时发一把新密钥（只在这次响应里返回）
        if "public" in b:
            if b["public"]:
                fields["secret_hash"] = ""
            elif app["secret_hash"]:
                pass                                   # 已经是机密客户端：密钥不变（要换用轮换接口）
            else:
                new_secret = cm_passport.new_client_secret()
                fields["secret_hash"] = cm_passport.hash_token(new_secret)
        cm_db.passport_app_update(app["key"], **fields)
        if fields.get("disabled"):
            cm_db.passport_grant_revoke(app_key=app["key"])
        cm_db.passport_event("app.update", app["key"], u["id"], ip,
                             handler.headers.get("User-Agent", ""),
                             json.dumps({k: v for k, v in fields.items() if k != "secret_hash"},
                                        ensure_ascii=False)[:300])
        out = {"ok": True, "app": _app_json(cm_db.passport_app_get(app["key"]))}
        if new_secret:
            out["clientSecret"] = new_secret
            out["note"] = "已切换为机密客户端，clientSecret 只返回这一次"
        return jresp(handler, 200, out)

    if m and method == "DELETE":
        u = require_user(handler)
        app, is_admin = _app_owned(u, m.group(1))
        cm_db.passport_app_delete(app["key"])
        cm_db.passport_event("app.disable", app["key"], u["id"], ip,
                             handler.headers.get("User-Agent", ""), "")
        return jresp(handler, 200, {"ok": True})

    # 轮换密钥（开发者平台「获取令牌」用：密钥丢了/泄漏了就换一把）
    m2 = re.fullmatch(r"/passport/apps/([A-Za-z0-9_\-]{4,64})/secret", path)
    if m2 and method == "POST":
        u = require_user(handler)
        app, is_admin = _app_owned(u, m2.group(1))
        secret = cm_passport.new_client_secret()
        cm_db.passport_app_update(app["key"], secret_hash=cm_passport.hash_token(secret))
        # 换密钥 = 老客户端凭据立刻失效：该应用已发出的令牌一并撤销，逼客户端重新授权
        revoked = cm_db.passport_grant_revoke(app_key=app["key"]) if (body or {}).get("revokeGrants") else 0
        cm_db.passport_event("app.rotate_secret", app["key"], u["id"], ip,
                             handler.headers.get("User-Agent", ""), f"revoked={revoked}")
        return jresp(handler, 200, {
            "clientId": app["key"], "clientSecret": secret, "revokedGrants": revoked,
            "note": "clientSecret 只返回这一次；旧密钥立即失效",
        })

    # ---- 授权：同意页数据（GET）与批准（POST）----
    def _authorize_params(src):
        """从 query/body 取授权参数并做前置校验（回调地址必须是**已登记**的）。"""
        app = cm_db.passport_app_get(str(src.get("client_id") or "").strip())
        if not app or app["disabled"]:
            raise ApiError(400, "应用不存在或已停用（client_id 不合法）")
        redirect_uri = str(src.get("redirect_uri") or "").strip()
        redirects = json.loads(app["redirects"] or "[]")
        if not cm_passport.redirect_match(redirects, redirect_uri):
            # 回调地址不可信：**不能**重定向过去，只能直接报错
            raise ApiError(400, "redirect_uri 与登记的回调地址不一致（必须精确匹配，且 https）")
        scope = cm_passport.parse_scope(src.get("scope") or cm_passport.DEFAULT_SCOPE,
                                        app_scopes=app["scopes"])
        state = str(src.get("state") or "")[:200]
        challenge, method_c = cm_passport.check_code_challenge(
            str(src.get("code_challenge") or ""), src.get("code_challenge_method") or "S256")
        if not app["secret_hash"] and not challenge:
            raise ApiError(400, "公开客户端必须提供 code_challenge（PKCE）")
        return app, redirect_uri, scope, state, challenge, method_c

    if path == "/passport/authorize" and method == "GET":
        u = require_user(handler)
        app, redirect_uri, scope, state, challenge, method_c = _authorize_params(q)
        sub = cm_db.passport_uid(u["id"])
        granted = set()
        for g in cm_db.passport_grant_list_user(u["id"]):
            if g["app_key"] == app["key"]:
                granted |= set(cm_passport.scope_names(g["scope"]))
        return jresp(handler, 200, {
            "app": {"clientId": app["key"], "name": app["name"], "homepage": app["homepage"],
                    "logo": app["logo"], "firstParty": bool(app["first_party"])},
            "redirectUri": redirect_uri,
            "scope": scope,
            "scopes": [{"scope": k, "label": v["label"], "desc": v["desc"],
                        "required": v["required"], "requested": True, "already": k in granted}
                       for k, v in cm_passport.SCOPES.items() if k in cm_passport.scope_names(scope)],
            "user": {"sub": sub, "nickname": u.get("nickname") or "", "avatar": u.get("avatar") or "",
                     "title": u.get("title") or "", "isOwner": bool(u.get("is_owner")),
                     "isSuper": bool(u.get("is_super")), "isAdmin": bool(u.get("is_admin"))},
            "state": state,
            "ttl": {"code": cm_passport.CODE_TTL, "access": cm_passport.ACCESS_TTL,
                    "refresh": cm_passport.REFRESH_TTL},
        })

    if path == "/passport/authorize" and method == "POST":
        u = require_user(handler)
        b = body or {}
        app, redirect_uri, scope, state, challenge, method_c = _authorize_params(b)
        sep = "&" if "?" in redirect_uri else "?"
        if not b.get("approve"):
            cm_db.passport_event("authorize.deny", app["key"], u["id"], ip,
                                 handler.headers.get("User-Agent", ""), scope)
            return jresp(handler, 200, {"redirect": f"{redirect_uri}{sep}error=access_denied"
                                        + (f"&state={quote(state)}" if state else "")})
        code = cm_passport.new_token("code")
        cm_db.passport_code_put(cm_passport.hash_token(code), app["key"], u["id"], redirect_uri,
                                scope, challenge, method_c,
                                cm_passport.hash_token(u.get("_token") or ""), cm_passport.CODE_TTL)
        cm_db.passport_event("authorize.approve", app["key"], u["id"], ip,
                             handler.headers.get("User-Agent", ""), scope)
        return jresp(handler, 200, {
            "redirect": f"{redirect_uri}{sep}code={quote(code)}"
                        + (f"&state={quote(state)}" if state else ""),
            "expiresIn": cm_passport.CODE_TTL,
        })

    # ---- 令牌端点 ----
    if path == "/passport/token" and method == "POST":
        b = body or {}
        # 客户端认证：Basic（推荐）或表单参数；公开客户端没有密钥，靠 PKCE
        cid = csec = ""
        auth = handler.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                import base64
                raw = base64.b64decode(auth[6:]).decode("utf-8", "replace")
                cid, _, csec = raw.partition(":")
            except Exception:  # noqa: BLE001
                raise ApiError(401, "Basic 认证头解析失败")
        cid = str(b.get("client_id") or cid or "").strip()
        csec = str(b.get("client_secret") or csec or "").strip()
        if cm_passport.rate_limited(f"{ip}:{cid}"):
            raise ApiError(429, "令牌请求过于频繁，请稍后再试")
        app = cm_db.passport_app_get(cid)
        if not app or app["disabled"]:
            raise ApiError(401, "client_id 无效或应用已停用")
        if app["secret_hash"]:
            if not csec or not secrets.compare_digest(cm_passport.hash_token(csec), app["secret_hash"]):
                cm_db.passport_event("token.bad_secret", cid, 0, ip,
                                     handler.headers.get("User-Agent", ""), "")
                raise ApiError(401, "client_secret 不正确")
        grant_type = str(b.get("grant_type") or "").strip()
        try:
            if grant_type == "authorization_code":
                code = str(b.get("code") or "").strip()
                if not code:
                    raise cm_passport.PassportError("invalid_request", "缺少 code")
                rec = cm_db.passport_code_take(cm_passport.hash_token(code))
                if not rec:
                    raise cm_passport.PassportError("invalid_grant", "授权码不存在、已使用或已过期")
                if rec["app_key"] != app["key"]:
                    raise cm_passport.PassportError("invalid_grant", "授权码不属于该应用")
                ru = str(b.get("redirect_uri") or rec["redirect_uri"]).strip()
                if ru != rec["redirect_uri"]:
                    raise cm_passport.PassportError("invalid_grant", "redirect_uri 与授权时不一致")
                if rec["challenge"]:
                    if not cm_passport.check_pkce(rec["challenge"], rec["method"], str(b.get("code_verifier") or "")):
                        raise cm_passport.PassportError("invalid_grant", "code_verifier 校验失败")
                scope = rec["scope"]
                uid = rec["uid"]
                access = cm_passport.new_token("at")
                refresh = cm_passport.new_token("rt") if cm_passport.has_scope(scope, "offline_access") else ""
                now_t = cm_passport.now()
                cm_db.passport_grant_create(
                    cm_passport.new_grant_id(), app["key"], uid, scope,
                    cm_passport.hash_token(access), cm_passport.hash_token(refresh) if refresh else "",
                    now_t + cm_passport.ACCESS_TTL,
                    now_t + (cm_passport.REFRESH_TTL if refresh else 0),
                    sid=rec["sid"] or "", device=str(b.get("device") or "")[:120],
                    platform=str(b.get("platform") or "")[:20])
                cm_db.passport_event("token.issue", app["key"], uid, ip,
                                     handler.headers.get("User-Agent", ""), scope)
                out = {"access_token": access, "token_type": "Bearer",
                       "expires_in": cm_passport.ACCESS_TTL, "scope": scope,
                       "sub": cm_db.passport_uid(uid)}
                if refresh:
                    out["refresh_token"] = refresh
                    out["refresh_expires_in"] = cm_passport.REFRESH_TTL
                return jresp(handler, 200, out)

            if grant_type == "refresh_token":
                rt = str(b.get("refresh_token") or "").strip()
                if not rt:
                    raise cm_passport.PassportError("invalid_request", "缺少 refresh_token")
                g = cm_db.passport_grant_by_refresh(cm_passport.hash_token(rt))
                if not g or g["app_key"] != app["key"]:
                    raise cm_passport.PassportError("invalid_grant", "刷新令牌无效或已撤销")
                if g["refresh_expires"] < cm_passport.now():
                    cm_db.passport_grant_revoke(uid=None, gid=g["id"])
                    raise cm_passport.PassportError("invalid_grant", "刷新令牌已过期，请重新授权")
                if not g["uid"]:
                    raise cm_passport.PassportError("invalid_grant", "该授权不包含用户")
                access = cm_passport.new_token("at")
                refresh = cm_passport.new_token("rt")          # 轮换：旧 refresh 立即失效
                now_t = cm_passport.now()
                cm_db.passport_grant_rotate(g["id"], cm_passport.hash_token(access),
                                            cm_passport.hash_token(refresh),
                                            now_t + cm_passport.ACCESS_TTL,
                                            now_t + cm_passport.REFRESH_TTL)
                cm_db.passport_event("token.refresh", app["key"], g["uid"], ip,
                                     handler.headers.get("User-Agent", ""), g["scope"])
                return jresp(handler, 200, {
                    "access_token": access, "token_type": "Bearer",
                    "expires_in": cm_passport.ACCESS_TTL, "refresh_token": refresh,
                    "refresh_expires_in": cm_passport.REFRESH_TTL, "scope": g["scope"],
                    "sub": cm_db.passport_uid(g["uid"]),
                })

            if grant_type == "client_credentials":
                if app["secret_hash"] and not csec:
                    raise cm_passport.PassportError("invalid_client", "机密客户端必须提供 client_secret", 401)
                scope = cm_passport.parse_scope(b.get("scope") or "openid", app_scopes=app["scopes"])
                access = cm_passport.new_token("at")
                now_t = cm_passport.now()
                cm_db.passport_grant_create(
                    cm_passport.new_grant_id(), app["key"], 0, scope,
                    cm_passport.hash_token(access), "", now_t + cm_passport.ACCESS_TTL, 0)
                cm_db.passport_event("token.client_credentials", app["key"], 0, ip,
                                     handler.headers.get("User-Agent", ""), scope)
                return jresp(handler, 200, {"access_token": access, "token_type": "Bearer",
                                            "expires_in": cm_passport.ACCESS_TTL, "scope": scope})

            raise cm_passport.PassportError("unsupported_grant_type",
                                            f"不支持的 grant_type：{grant_type or '(空)'}")
        except cm_passport.PassportError as e:
            cm_db.passport_event("token.error", cid, 0, ip,
                                 handler.headers.get("User-Agent", ""), f"{e.error}:{e.desc}")
            handler.send_response(e.status)
            handler.send_header("Content-Type", "application/json; charset=utf-8")
            handler.send_header("Access-Control-Allow-Origin", "*")
            if e.status == 401:
                handler.send_header("WWW-Authenticate", 'Basic realm="CurrentStation Passport"')
            payload = json.dumps({"error": e.error, "error_description": e.desc},
                                 ensure_ascii=False).encode("utf-8")
            handler.send_header("Content-Length", str(len(payload)))
            handler.end_headers()
            handler.wfile.write(payload)
            return

    def _bearer(handler):
        auth = handler.headers.get("Authorization", "")
        tok = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not tok:
            tok = str((body or {}).get("access_token") or q.get("access_token") or "").strip()
        return tok

    # ---- 用户信息（第三方拿它换资料）----
    if path in ("/passport/userinfo", "/passport/.well-known/userinfo") and method in ("GET", "POST"):
        tok = _bearer(handler)
        g = cm_db.passport_grant_by_access(cm_passport.hash_token(tok)) if tok else None
        if not g or g["access_expires"] < cm_passport.now():
            handler.send_response(401)
            handler.send_header("WWW-Authenticate", 'Bearer error="invalid_token"')
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        if not g["uid"]:
            raise ApiError(403, "这是应用令牌（client_credentials），没有用户信息")
        u = cm_db.get_user(g["uid"])
        if not u or u.get("disabled"):
            raise ApiError(403, "账号不可用")
        cm_db.passport_grant_touch(g["id"])
        cm_db.passport_event("userinfo", g["app_key"], g["uid"], ip,
                             handler.headers.get("User-Agent", ""), g["scope"])
        out = cm_passport.userinfo(u, g["scope"], cm_db.passport_uid(g["uid"]))
        out["scope"] = g["scope"]
        out["client_id"] = g["app_key"]
        return jresp(handler, 200, out)

    # ---- 令牌自省（第三方后端校验别人拿来的令牌）----
    if path == "/passport/introspect" and method == "POST":
        b = body or {}
        cid = str(b.get("client_id") or "").strip()
        csec = str(b.get("client_secret") or "").strip()
        auth = handler.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                import base64
                raw = base64.b64decode(auth[6:]).decode("utf-8", "replace")
                cid, _, csec = raw.partition(":")
            except Exception:  # noqa: BLE001
                raise ApiError(401, "Basic 认证头解析失败")
        app = cm_db.passport_app_get(cid)
        if not app or (app["secret_hash"] and not secrets.compare_digest(
                cm_passport.hash_token(csec), app["secret_hash"])):
            raise ApiError(401, "客户端认证失败")
        tok = str(b.get("token") or "").strip()
        g = cm_db.passport_grant_by_access(cm_passport.hash_token(tok)) if tok else None
        kind = "access_token"
        if not g and tok:
            g = cm_db.passport_grant_by_refresh(cm_passport.hash_token(tok))
            kind = "refresh_token"
        if not g or g["app_key"] != app["key"]:
            return jresp(handler, 200, {"active": False})
        exp = g["access_expires"] if kind == "access_token" else g["refresh_expires"]
        if exp < cm_passport.now():
            return jresp(handler, 200, {"active": False})
        return jresp(handler, 200, {
            "active": True, "scope": g["scope"], "client_id": g["app_key"],
            "token_type": kind, "exp": exp, "iat": g["created_at"],
            "sub": cm_db.passport_uid(g["uid"]) if g["uid"] else "",
            "username": "",
        })

    # ---- 撤销（第三方或用户都可撤）----
    if path == "/passport/revoke" and method == "POST":
        b = body or {}
        tok = str(b.get("token") or "").strip()
        if not tok:
            raise ApiError(400, "缺少 token")
        gid = None
        g = cm_db.passport_grant_by_access(cm_passport.hash_token(tok))
        if not g:
            g = cm_db.passport_grant_by_refresh(cm_passport.hash_token(tok))
        if g:
            # 允许：应用自己撤（带 client 认证）或 授权用户自己撤（带会话）
            cid = str(b.get("client_id") or "").strip()
            csec = str(b.get("client_secret") or "").strip()
            auth = handler.headers.get("Authorization", "")
            if auth.startswith("Basic "):
                try:
                    import base64
                    raw = base64.b64decode(auth[6:]).decode("utf-8", "replace")
                    cid, _, csec = raw.partition(":")
                except Exception:  # noqa: BLE001
                    pass
            app = cm_db.passport_app_get(cid) if cid else None
            by_app = bool(app and app["key"] == g["app_key"] and (
                not app["secret_hash"] or secrets.compare_digest(
                    cm_passport.hash_token(csec), app["secret_hash"])))
            u = optional_user(handler)
            if not by_app and not (u and u["id"] == g["uid"]):
                raise ApiError(403, "无权撤销该令牌")
            gid = g["id"]
            cm_db.passport_grant_revoke(uid=None, gid=gid)
            cm_db.passport_event("token.revoke", g["app_key"], g["uid"], ip,
                                 handler.headers.get("User-Agent", ""), "")
        return jresp(handler, 200, {"ok": True})       # RFC 7009：无论存在与否都返回 200

    # ---- 授权管理（用户自己看/撤）----
    if path == "/passport/grants" and method == "GET":
        u = require_user(handler)
        out = []
        for g in cm_db.passport_grant_list_user(u["id"]):
            sc = cm_passport.scope_names(g["scope"])
            out.append({
                "id": g["id"], "clientId": g["app_key"], "app": g["app_name"] or g["app_key"],
                "homepage": g["app_homepage"] or "", "firstParty": bool(g["app_first_party"]),
                "scope": g["scope"],
                "scopes": [{"scope": k, **cm_passport.SCOPES.get(k, {"label": k, "desc": ""})} for k in sc],
                "createdAt": g["created_at"], "lastUsed": g["last_used"],
                "device": g["device"] or "", "platform": g["platform"] or "",
            })
        return jresp(handler, 200, {"grants": out})

    m = re.fullmatch(r"/passport/grants/([A-Za-z0-9_\-]{4,64})", path)
    if m and method == "DELETE":
        u = require_user(handler)
        n = cm_db.passport_grant_revoke(uid=u["id"], gid=m.group(1))
        if not n:
            raise ApiError(404, "授权不存在或已撤销")
        cm_db.passport_event("grant.revoke", "", u["id"], ip,
                             handler.headers.get("User-Agent", ""), m.group(1))
        return jresp(handler, 200, {"ok": True, "revoked": n})

    # ---- 审计（管理员）----
    if path == "/passport/events" and method == "GET":
        u = require_user(handler)
        if not (u.get("is_admin") or u.get("is_super")):
            raise ApiError(403, "需要管理员权限")
        rows = cm_db.passport_events(int(q.get("limit") or 100),
                                     uid=int(q.get("uid") or 0), app_key=q.get("app_key") or "")
        return jresp(handler, 200, {"events": rows})

    # ---- 资料与头像 ----
    if path == "/profile" and method == "GET":
        u = require_user(handler)
        out = public_user(u)
        out["stat"] = cm_db.user_stat(u["id"])
        return jresp(handler, 200, out)

    if path == "/profile" and method == "PUT":
        u = require_user(handler)
        if "publicSquare" in (body or {}):
            cm_db.set_public_square(u["id"], bool(body.get("publicSquare")))
        cm_db.update_profile(u["id"], body)
        return jresp(handler, 200, public_user(cm_db.get_user(u["id"])))

    # ---- 修改密码：原密码 或 邮箱验证码（v1.28.76）----
    # 已登录用户忘记原密码时，可让服务端把验证码发到**当前账号绑定**的邮箱；
    # 验证通过后保留当前设备、下线其他设备。未登录的找回走 /auth/password/*。
    if path == "/profile/password/code" and method == "POST":
        u = require_user(handler)
        email = str(u.get("email") or "").strip().lower()
        if not email:
            raise ApiError(400, "当前账号未绑定邮箱，请先在设置中绑定邮箱")
        if not cm_mail.smtp_ready():
            raise ApiError(500, "邮件服务未配置，请联系管理员")
        now = int(time.time())
        _email_ip_budget(ip, now)
        k = _password_code_key(email)
        row = cm_db.get_email_code(k)
        if row and now - row["sent_at"] < 60:
            raise ApiError(429, f"发送太频繁，请 {60 - (now - row['sent_at'])} 秒后再试")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            cm_mail.send_code_email(email, code, 5, "修改密码")
        except Exception as e:  # noqa: BLE001
            log.warning("修改密码验证码发送失败 to=%s: %s", email, e)
            raise ApiError(502, "邮件发送失败，请稍后重试")
        cm_db.save_email_code(k, code, 300)
        _email_ip_hour.setdefault(ip, []).append(now)
        log.info("发送修改密码验证码 uid=%s ip=%s", u["id"], ip)
        return jresp(handler, 200, {"ok": True, "ttl": 300,
                                    "email": cm_passport.mask_email(email)})

    if path == "/profile/password" and method == "PUT":
        u = require_user(handler)
        b = body or {}
        new_pw = str(b.get("newPassword") or "")
        if not (6 <= len(new_pw) <= 64):
            raise ApiError(400, "新密码长度需 6~64 位")
        email_code = str(b.get("emailCode") or "").strip()
        if email_code:
            email = str(u.get("email") or "").strip().lower()
            if not email:
                raise ApiError(400, "当前账号未绑定邮箱，无法使用邮箱验证码修改密码")
            _check_email_code(email, email_code, int(time.time()), key=_password_code_key(email))
            cm_db.set_password(u["id"], new_pw)
            cur = u.get("_token")
            removed = 0
            for s in cm_db.list_sessions(u["id"], cur):
                if not s["current"] and cm_db.revoke_session(u["id"], s["id"]):
                    removed += 1
            log.info("邮箱验证码修改密码成功 uid=%s revoked=%d ip=%s", u["id"], removed, ip)
            return jresp(handler, 200, {"ok": True, "revoked": removed})
        old_pw = str(b.get("oldPassword") or "")
        if not old_pw:
            raise ApiError(400, "请填写原密码或邮箱验证码")
        if not cm_db.change_password(u["id"], old_pw, new_pw):
            raise ApiError(400, "原密码错误")
        return jresp(handler, 200, {"ok": True})

    # ---- 绑定 / 换绑邮箱（v1.28.32）：验证码证明邮箱所有权后才入库；
    # 码存 bind:<email> 命名空间（与注册码/登录码互不通用）。
    if path == "/profile/email/code" and method == "POST":
        u = require_user(handler)
        email = str((body or {}).get("email") or "").strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "邮箱格式不正确")
        if email == (u.get("email") or ""):
            raise ApiError(400, "该邮箱已是当前账号的邮箱")
        other = cm_db.get_user_by_email(email)
        if other and other["id"] != u["id"]:
            raise ApiError(409, "该邮箱已被其他账号使用")
        if not cm_mail.smtp_ready():
            raise ApiError(500, "邮件服务未配置，请联系管理员")
        now = int(time.time())
        cutoff = now - 3600
        _email_ip_hour[ip] = [t for t in _email_ip_hour.get(ip, []) if t > cutoff]
        if len(_email_ip_hour[ip]) >= 10:
            raise ApiError(429, "当前网络请求验证码过于频繁，请稍后再试")
        k = f"bind:{email}"
        row = cm_db.get_email_code(k)
        if row and now - row["sent_at"] < 60:
            raise ApiError(429, f"发送太频繁，请 {60 - (now - row['sent_at'])} 秒后再试")
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            cm_mail.send_code_email(email, code, 5, "绑定")
        except Exception as e:  # noqa: BLE001
            log.warning("绑定验证码发送失败 to=%s: %s", email, e)
            raise ApiError(502, "邮件发送失败，请稍后重试")
        cm_db.save_email_code(k, code, 300)
        _email_ip_hour.setdefault(ip, []).append(now)
        return jresp(handler, 200, {"ok": True, "ttl": 300})

    if path == "/profile/email" and method == "PUT":
        u = require_user(handler)
        email = str((body or {}).get("email") or "").strip().lower()
        code = str(body.get("code") or "").strip()
        if not email or not code:
            raise ApiError(400, "请填写邮箱与验证码")
        _check_email_code(email, code, int(time.time()), key=f"bind:{email}")
        other = cm_db.get_user_by_email(email)     # 验码期间被别人抢绑：再查一次
        if other and other["id"] != u["id"]:
            raise ApiError(409, "该邮箱已被其他账号使用")
        cm_db.set_email(u["id"], email)
        log.info("绑定邮箱 uid=%s ip=%s", u["id"], ip)
        return jresp(handler, 200, public_user(cm_db.get_user(u["id"])))

    if path == "/profile/avatar" and method == "PUT":
        u = require_user(handler)
        import base64
        try:
            data = base64.b64decode(str((body or {}).get("data") or ""), validate=True)
        except Exception:
            raise ApiError(400, "头像数据无效")
        if not (0 < len(data) <= 1024 * 1024):
            raise ApiError(400, "图片需 ≤1MB")
        ext = {b"\x89PNG": "png", b"\xff\xd8\xff": "jpg", b"RIFF": "webp"}
        kind = next((e for magic, e in ext.items() if data[:4] == magic or data[:3] == magic), None)
        if not kind:
            raise ApiError(400, "仅支持 PNG/JPG/WebP")
        os.makedirs(AVATAR_DIR, exist_ok=True)
        # 头像展示尺寸 ≤128px，原图常有几百 KB：服务端统一压到 256px 再落盘；
        # 文件名带内容 hash（换头像=换 URL），serve 端才敢给 immutable 长缓存。
        try:
            data = _avatar_shrink(data, kind)
        except ValueError as e:
            raise ApiError(400, str(e))
        if kind == "png" and data[:3] == b"\xff\xd8\xff":
            kind = "jpg"   # 无透明的 PNG 直接转 JPEG，体积更小
        h = hashlib.sha1(data).hexdigest()[:6]
        fname = f"{u['id']}-{h}.{kind}"
        with open(os.path.join(AVATAR_DIR, fname), "wb") as f:
            f.write(data)
        cm_db.update_profile(u["id"], {"avatar": fname})
        return jresp(handler, 200, {"avatar": fname})

    # 兼容两种文件名：旧版 {uid}.{ext} 与 v1.28.75 起 {uid}-{hash}.{ext}（内容寻址）。
    # 旧文件保留不删（听歌房成员快照仍引用旧名），新旧都能 immutable 长缓存。
    m = re.fullmatch(r"/avatar/(\d+(?:-[0-9a-f]{1,8})?\.(?:png|jpg|webp))", path)
    if m and method == "GET":
        fp = os.path.join(AVATAR_DIR, m.group(1))
        if not os.path.isfile(fp):
            raise ApiError(404, "头像不存在")
        with open(fp, "rb") as f:
            data = f.read()
        ctype = "image/png" if fp.endswith("png") else ("image/webp" if fp.endswith("webp") else "image/jpeg")
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Cache-Control", "public, max-age=31536000, immutable")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return

    m = re.fullmatch(r"/profile/(\d+)", path)
    if m and method == "GET":
        target = cm_db.get_user(int(m.group(1)))
        if not target:
            raise ApiError(404, "用户不存在")
        out = public_user(target)
        out["stat"] = cm_db.user_stat(target["id"])
        out["playlists"] = cm_db.playlists_of(target["id"])
        return jresp(handler, 200, out)

    # ---- 头像挂件 ----
    if path == "/decorations" and method == "GET":
        # 目录公开（挂件要在广场/主页公开展示）；带 token 时附带本人解锁状态
        uid, mine = 0, ""
        if handler.headers.get("Authorization", "").startswith("Bearer "):
            try:
                me = require_user(handler)
                uid, mine = me["id"], me.get("avatar_decoration") or ""
            except ApiError:
                pass
        ms = cm_db.listen_ms(uid) if uid else 0
        unlocked = uid and ms >= cm_db.DECOR_MIN_MS
        cat = cm_decor.catalog()
        return jresp(handler, 200, {
            "version": cm_decor.catalog_version(),
            "minListenMs": cm_db.DECOR_MIN_MS,
            "listenMs": ms,
            "unlocked": bool(unlocked),
            "current": mine,
            "scales": {d["id"]: d["scale"] for d in cat},
            "decorations": [
                {"id": d["id"], "name": d["name"], "description": d["description"],
                 "format": d["format"], "width": d["width"], "height": d["height"],
                 # scale：素材透明留白补偿，前端按 头像尺寸 × scale 渲染
                 "scale": d["scale"]}
                for d in cat
            ],
        })

    if path == "/decorations/mine" and method == "PUT":
        u = require_user(handler)
        did = str((body or {}).get("id") or "").strip()
        # 未设置/未达标时给出区分度明确的提示，前端据此展示解锁进度
        if did:
            if not cm_decor.get(did):
                raise ApiError(404, "挂件不存在或已下架")
            ms = cm_db.listen_ms(u["id"])
            if ms < cm_db.DECOR_MIN_MS:
                left = (cm_db.DECOR_MIN_MS - ms + 59999) // 60000
                raise ApiError(403, f"听歌时长满 2 小时才能设置头像挂件（还差约 {left} 分钟）")
        cm_db.set_avatar_decoration(u["id"], did)
        out = public_user(cm_db.get_user(u["id"]))
        return jresp(handler, 200, {"avatarDecoration": out["avatarDecoration"]})

    # 挂件放大比例表（广场/主页等只拿到挂件 id 的界面用它换算尺寸；体积极小，可长缓存）
    if path == "/decorations/scales" and method == "GET":
        cat = cm_decor.catalog()
        return jresp(handler, 200, {
            "version": cm_decor.catalog_version(),
            "scales": {d["id"]: d["scale"] for d in cat},
        })

    # 扩展名可选：挂件 id 唯一决定文件，目录里同时有 gif/png/apng（PNG 却请求 .gif 会 404）
    m = re.fullmatch(r"/decor/([a-z0-9]{4,32})(?:\.(?:gif|png|apng))?", path)
    if m and method == "GET":
        data, ctype = cm_decor.open_image(m.group(1))
        if not data:
            raise ApiError(404, "挂件图片不存在")
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Access-Control-Allow-Origin", "*")
        # 挂件文件按 id 寻址、内容不变，可长缓存（换挂件会换 URL）
        handler.send_header("Cache-Control", "public, max-age=604800, immutable")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return

    # ---- 元数据回填 ----
    if path == "/meta" and method == "POST":
        require_user(handler)
        metas = body.get("songs") if isinstance(body, dict) else body
        if not isinstance(metas, list) or len(metas) > 100:
            raise ApiError(400, "songs 列表需 ≤100 条")
        for m_ in metas:
            cm_db.upsert_song(norm_meta(m_))
        return jresp(handler, 200, {"ok": True})

    # ---- 点赞 / 收藏 ----
    m = re.fullmatch(r"/likes/(\d+)", path)
    if m and method == "POST":
        u = require_user(handler)
        ncm_id = int(m.group(1))
        cm_db.upsert_song(norm_meta({**(body or {}), "ncm_id": ncm_id}))
        liked = cm_db.toggle_like(u["id"], ncm_id)
        return jresp(handler, 200, {"on": liked, "count": cm_db.like_counts([ncm_id])[ncm_id]})

    if path == "/likes/mine" and method == "GET":
        u = require_user(handler)
        ids = cm_db.like_ids(u["id"], table="likes")
        return jresp(handler, 200, {"songs": cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids))})

    if path == "/favs/mine" and method == "GET":
        u = require_user(handler)
        ids = cm_db.like_ids(u["id"], table="favs")
        return jresp(handler, 200, {"songs": cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids))})

    if path == "/likes/count" and method == "GET":
        ids = q.get("ids", "")
        try:
            id_list = [int(i) for i in ids.split(",") if i.strip()][:100]
        except ValueError:
            raise ApiError(400, "ids 参数错误")
        return jresp(handler, 200, {
            "counts": cm_db.like_counts(id_list),
            "ncmCounts": _ncm_like_counts(id_list) if id_list else {},
        })

    if path == "/songs/status" and method == "GET":
        """列表渲染一次拉全：点赞/收藏状态 + 自建点赞数。未登录只给 counts。"""
        ids = q.get("ids", "")
        try:
            id_list = [int(i) for i in ids.split(",") if i.strip()][:100]
        except ValueError:
            raise ApiError(400, "ids 参数错误")
        out = {"counts": cm_db.like_counts(id_list) if id_list else {},
               "ncmCounts": _ncm_like_counts(id_list) if id_list else {},
               "liked": [], "faved": []}
        if not id_list:
            return jresp(handler, 200, out)
        try:
            u = require_user(handler)
        except ApiError:
            u = None
        if u:
            out["liked"] = list(cm_db.is_liked(u["id"], id_list))
            from cm_db import connect
            conn = connect()
            marks = ",".join("?" * len(id_list))
            rows = conn.execute(
                f"SELECT ncm_id FROM favs WHERE user_id=? AND ncm_id IN ({marks})", [u["id"]] + id_list
            ).fetchall()
            out["faved"] = [r["ncm_id"] for r in rows]
            conn.close()
        return jresp(handler, 200, out)

    # ---- 歌单 ----
    if path == "/playlists" and method == "GET":
        u = require_user(handler)
        return jresp(handler, 200, {"playlists": cm_db.playlists_of(u["id"])})

    if path == "/playlists" and method == "POST":
        u = require_user(handler)
        name = str(body.get("name") or "").strip()
        if not name:
            raise ApiError(400, "歌单名不能为空")
        pid = cm_db.create_playlist(u["id"], name, str(body.get("description") or ""))
        return jresp(handler, 200, cm_db.get_playlist(pid))

    m = re.fullmatch(r"/playlists/(\d+)", path)
    if m:
        pid = int(m.group(1))
        pl = cm_db.get_playlist(pid)
        if not pl:
            raise ApiError(404, "歌单不存在")
        if method == "GET":
            ids = cm_db.playlist_track_ids(pid)
            return jresp(handler, 200, {**pl, "tracks": cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids))})
        u = require_user(handler)
        if pl["user_id"] != u["id"]:
            raise ApiError(403, "只能操作自己的歌单")
        if method == "PUT":
            cm_db.update_playlist(pid, body)
            return jresp(handler, 200, cm_db.get_playlist(pid))
        if method == "DELETE":
            cm_db.delete_playlist(pid)
            return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/playlists/(\d+)/tracks", path)
    if m:
        pid = int(m.group(1))
        pl = cm_db.get_playlist(pid)
        if not pl:
            raise ApiError(404, "歌单不存在")
        u = require_user(handler)
        if pl["user_id"] != u["id"]:
            raise ApiError(403, "只能操作自己的歌单")
        metas = body.get("songs") or []
        ids = []
        for m_ in metas:
            meta = norm_meta(m_)
            cm_db.upsert_song(meta)
            ids.append(meta["ncm_id"])
        if not ids:
            raise ApiError(400, "缺少歌曲")
        if method == "POST":
            cm_db.playlist_add_tracks(pid, ids)
        elif method == "DELETE":
            cm_db.playlist_del_tracks(pid, ids)
        return jresp(handler, 200, {"ok": True, "count": len(cm_db.playlist_track_ids(pid))})

    if path == "/ncm/comment/floor" and method == "GET":
        # 带 type 时说明调用方要的是「非歌曲维度」的楼层 —— 老实现只支持歌曲（写死 type=0），
        # 这里交给泛化网关处理；不带 type 则保持老行为，兼容旧版本 App。
        if q.get("type") is not None:
            handled = _ncm_forward(handler, method, path, q, body)
            if handled is not None:
                return handled
        try:
            ncm_id = int(q.get("id") or 0)
            cid = int(q.get("cid") or 0)
        except ValueError:
            raise ApiError(400, "参数错误")
        if not ncm_id or not cid:
            raise ApiError(400, "缺少 id/cid")
        key = f"cfloor:{cid}:{q.get('offset', '0')}"
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        out = cm_ncm.comment_floor(ncm_id, cid)
        cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), 120)
        return jresp(handler, 200, out)

    if path == "/ncm/hot" and method == "GET":
        cached = cm_db.cache_get("hot:v1")
        if cached:
            return jresp(handler, 200, {"list": json.loads(cached)})
        lst = cm_ncm.search_hot()
        cm_db.cache_set("hot:v1", json.dumps(lst, ensure_ascii=False), 3600)
        return jresp(handler, 200, {"list": lst})

    # ---- 网易云账号绑定 ----
    if path == "/ncmbind/import" and method == "POST":
        u = require_user(handler)
        try:
            result = cm_binding_import.import_binding(u["id"], body)
        except cm_binding_import.BindingImportError as exc:
            raise ApiError(exc.status, str(exc)) from None
        return jresp(handler, 200, result, cache_control="no-store")

    if path == "/ncmbind" and method == "GET":
        return jresp(handler, 200, _payload_bind(require_user(handler)))

    if path == "/ncmbind/session" and method == "GET":
        """第三方客户端用：一次返回「是否绑定 + 上游登录态是否有效 + 资料」。

        为什么单独一条：X 这类客户端在项目账号登录后需要立刻判断「要不要提示绑定
        网易云」，而现状要拼两个接口（/ncmbind 给绑定信息、/ncmbind/live 给有效性），
        且后者字段偏诊断。这里把判断收敛成 bound/valid/profile/note 四个稳定字段。
        **绝不返回 cookie**：客户端应继续用同一条 Bearer 调用 /ncm/* 的 T1/T2
        接口，由服务端注入绑定 cookie（见 docs/third-party-ncm-sync.md）。
        """
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b or not b.get("cookie"):
            return jresp(handler, 200, {"bound": False, "valid": False, "stale": False,
                                        "profile": None, "note": "尚未绑定网易云账号"})
        base = {"uid": b["ncm_uid"], "nickname": b["ncm_nickname"], "avatar": b["ncm_avatar"]}
        try:
            st = cm_ncm.login_status(b["cookie"])
        except Exception as e:  # noqa: BLE001 上游抖动时不轻易判失效
            return jresp(handler, 200, {"bound": True, "valid": None,
                                        "stale": bool(b["stale"]), "profile": base,
                                        "lastSync": b["last_sync"], "lastSyncCount": b["last_sync_count"],
                                        "note": f"上游查询失败，稍后再试：{e}"})
        ok = bool(st.get("ok"))
        prof = ((st.get("data") or {}).get("profile") or {})
        cm_db.mark_binding_stale(u["id"], 0 if ok else 1)
        return jresp(handler, 200, {
            "bound": True, "valid": ok, "stale": (not ok),
            "profile": {"uid": prof.get("userId") or base["uid"],
                        "nickname": prof.get("nickname") or base["nickname"],
                        "avatar": prof.get("avatarUrl") or base["avatar"]},
            "lastSync": b["last_sync"], "lastSyncCount": b["last_sync_count"],
            "note": "登录态有效" if ok else "网易云登录态已失效，请重新扫码绑定或调用 /ncmbind/refresh",
        })

    if path == "/ncmbind" and method == "DELETE":
        u = require_user(handler)
        cm_db.delete_binding(u["id"])
        return jresp(handler, 200, {"ok": True, "note": "已解绑（已导入的歌单保留为本地快照）"})

    # ---- T3 专用入口：登录态查/刷新（禁止经泛化转发，只在这里实现）----
    # 为什么必须有这两条：绑定 cookie 会过期，过期后**所有** T1/T2 接口都返回 401，
    # 用户看到的是"到处都失败"而不是"该重新绑定了"。这里用上游 /login/status 给出
    # 权威判据，/login/refresh 让用户能一键续期而不必重新扫码。
    if path == "/ncmbind/live" and method == "GET":
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b or not b.get("cookie"):
            return jresp(handler, 200, {"bound": False})
        try:
            st = cm_ncm.login_status(b["cookie"])
        except Exception as e:  # noqa: BLE001 上游抖动时不下"失效"结论
            return jresp(handler, 200, {"bound": True, "ok": False, "note": f"上游查询失败：{e}"})
        if st["ok"]:
            cm_db.mark_binding_stale(u["id"], 0)
            prof = ((st["data"] or {}).get("profile") or {})
            return jresp(handler, 200, {
                "bound": True, "ok": True,
                "profile": {"uid": prof.get("userId") or b["ncm_uid"],
                            "nickname": prof.get("nickname") or b["ncm_nickname"],
                            "avatar": prof.get("avatarUrl") or b["ncm_avatar"]},
            })
        cm_db.mark_binding_stale(u["id"], 1)
        return jresp(handler, 200, {"bound": True, "ok": False, "note": "网易云登录态已失效，请重新扫码绑定或尝试刷新"})

    if path == "/ncmbind/refresh" and method == "POST":
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b or not b.get("cookie"):
            raise ApiError(401, "请先绑定网易云账号后再使用该功能")
        new_cookie = cm_ncm.login_refresh(b["cookie"])
        cm_db.save_binding(u["id"], new_cookie, b["ncm_uid"], b["ncm_nickname"], b["ncm_avatar"])
        log.info("NCM 登录态刷新 user=%s", u["id"])
        return jresp(handler, 200, {"ok": True, "note": "登录态已刷新"})

    if path == "/ncmbind/qr/key" and method == "POST":
        u = require_user(handler)
        key = cm_ncm.qr_key()
        if not key:
            raise cm_ncm.NcmError("二维码创建失败，请稍后重试")
        now = time.time()
        with _qr_lock:
            for k in [k for k, (_, t) in _qr_sessions.items() if now - t > 600]:
                _qr_sessions.pop(k, None)
            _qr_sessions[key] = (u["id"], now)
        return jresp(handler, 200, {"key": key})

    if path == "/ncmbind/qr/img" and method == "GET":
        require_user(handler)
        key = q.get("key") or ""
        if not key:
            raise ApiError(400, "缺少 key")
        img = cm_ncm.qr_img(key)
        if not img:
            raise cm_ncm.NcmError("二维码图片获取失败")
        return jresp(handler, 200, {"qrimg": img})

    if path == "/ncmbind/qr/check" and method == "GET":
        u = require_user(handler)
        key = q.get("key") or ""
        sess = _qr_sessions.get(key)
        if not sess or sess[0] != u["id"]:
            raise ApiError(400, "会话不存在或已过期，请重新生成二维码")
        d = cm_ncm.qr_check(key) or {}
        code = d.get("code")
        if code == 803:
            cookie = d.get("cookie") or ""
            if not cookie:
                raise cm_ncm.NcmError("登录成功但未取得 cookie")
            prof = cm_ncm.user_account(cookie)
            cm_db.save_binding(u["id"], cookie, prof.get("uid"), prof.get("nickname"), prof.get("avatar"))
            with _qr_lock:
                _qr_sessions.pop(key, None)
            return jresp(handler, 200, {"code": 803, "profile": prof})
        if code == 800:
            with _qr_lock:
                _qr_sessions.pop(key, None)
        return jresp(handler, 200, {"code": code})

    if path == "/ncmbind/phone/code" and method == "POST":
        """手机验证码登录-第一步：发送验证码（每用户 60 秒冷却，避免刷上游短信）。"""
        u = require_user(handler)
        phone = re.sub(r"\D", "", str((body or {}).get("phone") or ""))
        ctcode = re.sub(r"\D", "", str((body or {}).get("ctcode") or "86")) or "86"
        if not (5 <= len(phone) <= 15):
            raise ApiError(400, "手机号格式不正确")
        ckey = f"phonesms:{u['id']}:{ctcode}{phone}"
        if cm_db.cache_get(ckey):
            raise ApiError(429, "验证码已发送，请 60 秒后再试")
        try:
            cm_ncm.phone_send_captcha(phone, ctcode)
        except cm_ncm.NcmError as e:
            # 上游明确返回的业务限制是客户端请求问题，不应伪装成 502。
            if e.status_code and 400 <= e.status_code < 500:
                raise ApiError(e.status_code, str(e))
            raise
        cm_db.cache_set(ckey, "1", 60)
        log.info("网易云手机验证码已发送 uid=%s phone=%s****%s", u["id"], ctcode, phone[-4:])
        return jresp(handler, 200, {"ok": True, "ttl": 300})

    if path == "/ncmbind/phone/login" and method == "POST":
        """手机验证码登录-第二步：校验并绑定账号。"""
        u = require_user(handler)
        phone = re.sub(r"\D", "", str((body or {}).get("phone") or ""))
        captcha = str((body or {}).get("captcha") or "").strip()
        ctcode = re.sub(r"\D", "", str((body or {}).get("ctcode") or "86")) or "86"
        if not phone or not captcha:
            raise ApiError(400, "手机号与验证码均不能为空")
        cookie = cm_ncm.phone_login(phone, captcha, ctcode)
        prof = cm_ncm.user_account(cookie)
        cm_db.save_binding(u["id"], cookie, prof.get("uid"), prof.get("nickname"), prof.get("avatar"))
        log.info("网易云手机登录绑定成功 uid=%s ncm_uid=%s", u["id"], prof.get("uid"))
        return jresp(handler, 200, {"ok": True, "profile": prof})

    if path == "/ncmbind/sync" and method == "POST":
        u = require_user(handler)
        return jresp(handler, 200, sync_ncm_playlists(u["id"]))

    if path == "/ncmbind/likelist" and method == "GET":
        """绑定账号的网易云红心 id 列表（10 分钟缓存），供喜欢菜单显示状态。
        未绑定/未同步时返回空集（200），避免前端噪音。"""
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b or not b["ncm_uid"]:
            return jresp(handler, 200, {"ids": []})
        key = f"nlikes:{u['id']}"
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, {"ids": json.loads(cached)})
        try:
            ids = cm_ncm.likelist(b["cookie"], b["ncm_uid"])
        except cm_ncm.NcmError as e:
            raise ApiError(502, f"获取网易云红心列表失败: {e}")
        cm_db.cache_set(key, json.dumps(ids), 600)
        return jresp(handler, 200, {"ids": ids})

    m = re.fullmatch(r"/ncmbind/like/(\d+)", path)
    if m and method == "POST":
        """红心/取消红心到绑定的网易云账号，并同步维护本地「我喜欢·网易云」快照。"""
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b:
            raise ApiError(400, "未绑定网易云账号，请先在「我的」页扫码绑定")
        ncm_id = int(m.group(1))
        meta = norm_meta({**(body or {}), "ncm_id": ncm_id})
        like = bool((body or {}).get("like", True))
        cm_db.upsert_song(meta)
        try:
            cm_ncm.like_song(b["cookie"], ncm_id, like,
                             real_ip=cm_ncm_gateway.client_ip(handler))
        except cm_ncm.NcmError as e:
            raise ApiError(502, str(e))
        cm_db.cache_set(f"nlikes:{u['id']}", "[]", 0)  # expires=0 → 立即失效，下次重新拉取
        counts = _ncm_like_counts([ncm_id], refresh=True)
        if b["ncm_liked_pl_id"]:
            pid = cm_db.find_ncm_playlist(u["id"], b["ncm_liked_pl_id"])
            if pid:
                if like:
                    cm_db.playlist_add_tracks(pid, [ncm_id])
                else:
                    cm_db.playlist_del_tracks(pid, [ncm_id])
        log.info("网易云红心 uid=%s song=%s like=%s", u["id"], ncm_id, like)
        return jresp(handler, 200, {"liked": like, "count": counts.get(ncm_id)})

    # ---- 播放历史 ----
    m = re.fullmatch(r"/plays/(\d+)", path)
    if m and method == "POST":
        u = require_user(handler)
        ncm_id = int(m.group(1))
        binding = cm_db.get_binding(u["id"])
        sync_cookie = (binding or {}).get("cookie") if binding else ""
        real_ip = cm_ncm_gateway.client_ip(handler)
        # 两种语义：
        #   不带 ms（或 ms<=0）→ 记一次「开始播放」（插入新记录，ms 从 0 起）
        #   带 ms>0            → 把这段**真实收听毫秒**累加到这首歌最近一次播放记录上
        # 前端每 30s 冲一次增量，并在切歌/暂停/隐藏页面时补冲，避免丢时长或算进暂停时间。
        ms = 0
        try:
            ms = int((body or {}).get("ms") or 0)
        except (TypeError, ValueError):
            ms = 0
        if ms > 0:
            added = cm_db.add_play_ms(u["id"], ncm_id, ms)
            # 满 60 秒才向用户自己的网易云账号提交一次合格播放；
            # 先原子领取再异步上报，失败由线程放回等下次增量重试。
            if added and sync_cookie:
                cand = cm_db.play_sync_candidate(u["id"], ncm_id)
                if cand:
                    _spawn_ncm_listen(sync_cookie, ncm_id, "play",
                                      seconds=cand["ms"] // 1000, rowid=cand["rowid"],
                                      real_ip=real_ip)
            return jresp(handler, 200, {"ok": True, "added": added})
        cm_db.upsert_song(norm_meta({**(body or {}), "ncm_id": ncm_id}))
        cm_db.record_play(u["id"], ncm_id)
        if sync_cookie:
            # 开始播放即写 startplay，让网易云「最近播放」实时出现。
            _spawn_ncm_listen(sync_cookie, ncm_id, "startplay", real_ip=real_ip)
        return jresp(handler, 200, {"ok": True})

    if path == "/plays/recent" and method == "GET":
        u = require_user(handler)
        return jresp(handler, 200, _payload_recent(u, int(q.get("limit") or 50)))

    # ---- 用户广场 / 公开主页（公开端点，无需登录） ----
    # ---- 帖子（发现页 · v1.21.15） ----
    if path == "/posts" and method == "GET":
        """帖子流（新→旧）。未登录也能看；登录则附带 likedByMe/canDelete。"""
        def _intp(name, default, lo, hi):
            try:
                v = int(q.get(name) or default)
            except (TypeError, ValueError):
                v = default
            return max(lo, min(v, hi))
        viewer = optional_user(handler)
        author = q.get("author")
        aid = int(author) if author and author.isdigit() else None
        return jresp(handler, 200, {
            "posts": cm_db.posts_list(
                viewer["id"] if viewer else None,
                offset=_intp("offset", 0, 0, 100000),
                limit=_intp("limit", 20, 1, 50), author_id=aid),
            "total": cm_db.posts_count(aid),
        })

    if path == "/posts" and method == "POST":
        u = require_user(handler)
        b = body or {}   # route() 顶部已统一读过 body，这里不能再读（会阻塞）
        try:
            pid = cm_db.post_create(u["id"], b.get("content"), b.get("attachments"))
        except ValueError as e:
            raise ApiError(400, str(e))
        return jresp(handler, 200, {"id": pid})

    m = re.fullmatch(r"/posts/(\d+)", path)
    if m and method == "DELETE":
        u = require_user(handler)
        if not cm_db.post_delete(u["id"], int(m.group(1))):
            raise ApiError(403, "只能删除自己的帖子")
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/posts/(\d+)/like", path)
    if m and method == "POST":
        u = require_user(handler)
        b = body or {}   # route() 顶部已统一读过 body，这里不能再读（会阻塞）
        n = cm_db.post_set_like(u["id"], int(m.group(1)), bool(b.get("on")))
        return jresp(handler, 200, {"likeCount": n})

    m = re.fullmatch(r"/posts/(\d+)/comments", path)
    if m and method == "GET":
        return jresp(handler, 200, {"comments": cm_db.post_comments_list(int(m.group(1)))})

    m = re.fullmatch(r"/posts/(\d+)/comments", path)
    if m and method == "POST":
        u = require_user(handler)
        b = body or {}   # route() 顶部已统一读过 body，这里不能再读（会阻塞）
        try:
            cid = cm_db.post_comment_add(u["id"], int(m.group(1)), b.get("content"))
        except ValueError as e:
            raise ApiError(400, str(e))
        return jresp(handler, 200, {"id": cid})

    m = re.fullmatch(r"/posts/comments/(\d+)", path)
    if m and method == "DELETE":
        u = require_user(handler)
        if not cm_db.post_comment_delete(u["id"], int(m.group(1))):
            raise ApiError(403, "只能删除自己的评论")
        return jresp(handler, 200, {"ok": True})

    if path == "/users/square" and method == "GET":
        try:
            limit = min(int(q.get("limit") or 30), 60)
            offset = max(int(q.get("offset") or 0), 0)
        except ValueError:
            raise ApiError(400, "分页参数错误")
        return jresp(handler, 200, cm_db.square_users(
            (q.get("query") or "").strip()[:50], q.get("sort") or "reg", limit, offset,
            listening_only=q.get("listening") in ("1", "true", "yes")))

    m = re.fullmatch(r"/users/(\d+)/profile", path)
    if m and method == "GET":
        prof = cm_db.public_profile(int(m.group(1)))
        if not prof:
            raise ApiError(404, "用户不存在")
        if prof["user"].get("public"):
            f = followed_netease(int(m.group(1)))
            if f and f.get("artists"):
                prof["followed"] = f["artists"][:24]          # 主页只展示前 24 位
                prof["followedCount"] = f.get("count") or len(f["artists"])
        return jresp(handler, 200, prof)

    # ---- NCM 音源代理（白名单） ----
    if path == "/ncm/search" and method == "GET":
        keywords = (q.get("keywords") or "").strip()[:100]
        if not keywords:
            raise ApiError(400, "缺少 keywords")

        def _int(name, default, lo, hi):
            try:
                v = int(q.get(name) or default)
            except (TypeError, ValueError):
                v = default
            return max(lo, min(v, hi))

        # 按类型搜索：不传 type 时保持旧行为（一次返回全部类型，供 room 等调用方）
        tsel = [t.strip() for t in (q.get("type") or q.get("types") or "").split(",")
                if t.strip() in cm_ncm._SEARCH_TYPES]
        tsel = list(dict.fromkeys(tsel))
        if "lyric" in tsel and len(tsel) != 1:
            raise ApiError(400, "歌词搜索请单独指定 type=lyric")
        limit = _int("limit", 30, 1, 50)
        offset = _int("offset", 0, 0, 1000)

        if not tsel:
            # 兼容旧调用：一次取回全部类型，歌手/专辑/歌单沿用较小的条数
            ckey = f"srch2b:{keywords}:{limit}"
            build = lambda: cm_ncm.search_multi(keywords, limit)   # noqa: E731
        else:
            # 缓存键必须含「类型 + 偏移 + 条数」：旧键 srch2:<kw> 不含这些，
            # 一旦分页就会互相覆盖（同一关键词翻第 2 页会拿到第 1 页的缓存）。
            prefix = "srch-lyric:v2" if tsel == ["lyric"] else "srch3"
            ckey = f"{prefix}:{keywords}:{','.join(tsel)}:{offset}:{limit}"
            build = lambda: cm_ncm.search_types(keywords, tuple(tsel), limit=limit, offset=offset)   # noqa: E731

        cached = cm_db.cache_get(ckey)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        d = build()
        # Incomplete pages must not freeze a temporary lookup failure; a retry sees fresh state.
        partial = tsel == ["lyric"] and any(not s.get("lyricContextComplete") for s in d.get("songs", []))
        if not partial:
            cm_db.cache_set(ckey, json.dumps(d, ensure_ascii=False), 600)
        return jresp(handler, 200, d)

    if path == "/artists/followed" and method == "GET":
        """已关注歌手：读用户自己网易云账号的 /artist/sublist（缓存 120s）。

        网易云写操作是**最终一致**（实测 sub/unsub 返回 200 后需数秒~数十秒才在
        sublist 生效），因此这里额外叠加「待生效意图」：刚在 App 里点过的关注/取关
        立即体现，待上游确认后自动清除，避免 UI 反复横跳。
        """
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b or not b["ncm_uid"]:
            raise ApiError(400, "请先绑定网易云账号")
        ckey, pkey = f"nsub:{u['id']}", f"nsubp:{u['id']}"
        raw = None if q.get("refresh") else cm_db.cache_get(ckey)
        if raw:
            d = json.loads(raw)
        else:
            try:
                d = cm_ncm.artist_sublist(b["cookie"], 100, 0)
            except cm_ncm.NcmError as e:
                raise ApiError(502, str(e))
            cm_db.cache_set(ckey, json.dumps(d, ensure_ascii=False), 120)
        pending = {}
        praw = cm_db.cache_get(pkey)
        if praw:
            try:
                pending = json.loads(praw)
            except ValueError:
                pending = {}
        if pending:
            ids = {int(a["artist_id"]) for a in d["artists"]}
            changed = False
            for aid, it in list(pending.items()):
                aid_i = int(aid)
                want = bool(it.get("on"))
                if want and aid_i not in ids:
                    d["artists"].insert(0, {"artist_id": aid_i, "name": it.get("name") or "",
                                            "pic": it.get("pic") or "", "alias": ""})
                    d["count"] = int(d.get("count") or 0) + 1
                    changed = True
                elif not want and aid_i in ids:
                    d["artists"] = [a for a in d["artists"] if int(a["artist_id"]) != aid_i]
                    d["count"] = max(0, int(d.get("count") or 0) - 1)
                    changed = True
                else:
                    pending.pop(aid, None)      # 上游已一致：意图完成，清掉
                    changed = True
            if changed:
                cm_db.cache_set(pkey, json.dumps(pending, ensure_ascii=False), 600)
                cm_db.cache_set(ckey, json.dumps(d, ensure_ascii=False), 120)
        return jresp(handler, 200, d)

    m = re.fullmatch(r"/artists/(\d+)/follow", path)
    if m and method == "POST":
        """关注/取关歌手：写用户的网易云账号（与网易云 App 同步）。
        网易云写操作偶发「先返回成功但未落库」，这里写后回读校验，不一致重试一次。"""
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b or not b["ncm_uid"]:
            raise ApiError(400, "请先绑定网易云账号")
        aid = int(m.group(1))
        on = bool((body or {}).get("on", True))
        try:
            cm_ncm.artist_sub(b["cookie"], aid, on,
                               real_ip=cm_ncm_gateway.client_ip(handler))
        except cm_ncm.NcmError as e:
            # 首次静默失败较常见（与 /like 同源）：重试一次
            log.info("关注歌手首次失败，重试一次 uid=%s artist=%s: %s", u["id"], aid, e)
            try:
                cm_ncm.artist_sub(b["cookie"], aid, on,
                               real_ip=cm_ncm_gateway.client_ip(handler))
            except cm_ncm.NcmError as e2:
                raise ApiError(502, str(e2))
        # 记录待生效意图（网易云最终一致，UI 先按用户意图展示）
        pkey = f"nsubp:{u['id']}"
        try:
            pending = json.loads(cm_db.cache_get(pkey) or "{}")
        except ValueError:
            pending = {}
        pending[str(aid)] = {"on": on, "name": str((body or {}).get("name") or "")[:120],
                             "pic": str((body or {}).get("pic") or "")[:500], "at": int(time.time())}
        cm_db.cache_set(pkey, json.dumps(pending, ensure_ascii=False), 600)
        cm_db.cache_delete(f"nsub:{u['id']}")     # 让下次读取重建
        return jresp(handler, 200, {"ok": True, "following": on})

    if path == "/ncm/album" and method == "GET":
        aid = int(q.get("id") or 0)
        if not aid:
            raise ApiError(400, "缺少 id")
        ckey = f"album:{aid}"
        cached = cm_db.cache_get(ckey)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        d = cm_ncm.album_songs(aid)
        cm_db.cache_set(ckey, json.dumps(d, ensure_ascii=False), 3600)
        return jresp(handler, 200, d)

    if path == "/ncm/artist" and method == "GET":
        aid = int(q.get("id") or 0)
        if not aid:
            raise ApiError(400, "缺少 id")
        try:
            limit = min(int(q.get("limit") or 100), 200)
            offset = max(int(q.get("offset") or 0), 0)
        except ValueError:
            raise ApiError(400, "分页参数错误")
        ckey = f"artist:{aid}:{offset}:{limit}"
        cached = cm_db.cache_get(ckey)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        d = cm_ncm.artist_works(aid, limit, offset)
        cm_db.cache_set(ckey, json.dumps(d, ensure_ascii=False), 3600)
        return jresp(handler, 200, d)

    if path == "/ncm/artist/albums" and method == "GET":
        aid = int(q.get("id") or 0)
        if not aid:
            raise ApiError(400, "缺少 id")
        try:
            limit = min(int(q.get("limit") or 30), 60)
            offset = max(int(q.get("offset") or 0), 0)
        except ValueError:
            raise ApiError(400, "分页参数错误")
        ckey = f"artistalb:{aid}:{offset}:{limit}"
        cached = cm_db.cache_get(ckey)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        d = cm_ncm.artist_albums(aid, limit, offset)
        cm_db.cache_set(ckey, json.dumps(d, ensure_ascii=False), 3600)
        return jresp(handler, 200, d)

    if path == "/ncm/song/url" and method == "GET":
        # v1.28.33：音源仅限注册用户（其他功能不受影响；游客仍可搜索/浏览/看歌词）
        require_user(handler)
        """播放地址解析（抗卡顿增强版，见 resolve_play_url）。

        参数：``id``（必填）、``level``（auto | 8 档任一）、``immerse``（仅 sky）、
        ``maxBr``（码率上限，仅 auto 生效）、``refresh=1``（卡顿自愈：换 CDN 线 / 换新签名）、
        ``alts=1``（附带已验证可互换的边缘列表）、``host``（指定边缘，须已验证）。
        """
        try:
            ncm_id = int(q.get("id") or 0)
        except ValueError:
            raise ApiError(400, "id 参数错误")
        if not ncm_id:
            raise ApiError(400, "缺少 id")
        level = q.get("level") or "auto"
        if level != "auto" and level not in VALID_LEVELS:
            level = "lossless"
        out = resolve_play_url(
            ncm_id, level,
            immerse=q.get("immerse") or None,          # 仅 sky 生效：c51(5.1)/ste(环绕立体声)
            # 把**真实用户 IP** 交给上游挑最近的 CDN 边缘节点。此前这条主路径没传
            # （只有泛化转发传了），等于让上游按源站所在地选节点，高峰期表现为播放卡。
            real_ip=cm_ncm_gateway.client_ip(handler),
            max_br=q.get("maxBr") or q.get("maxbr") or 0,
            refresh=_truthy(q.get("refresh")),
            alts=_truthy(q.get("alts")),
            want_host=(q.get("host") or "").strip(),
        )
        return jresp(handler, 200, out)

    # ---- 播放卡顿上报 / CDN 边缘健康度（v1.28.23） ----
    # 客户端在卡顿自愈与恢复正常时各报一次，服务端据此在**换线时避开问题边缘**。
    # 这是纯遥测：不写库、不影响播放，异常一律静默（绝不因为上报失败影响听歌）。
    if path == "/ncm/song/url/feedback" and method == "POST":
        ip = cm_ncm_gateway.client_ip(handler)
        if rate_limited(ip):                      # 复用全站限速，防刷
            return jresp(handler, 429, {"error": "操作过于频繁"})
        b = body or {}
        event = str(b.get("event") or "").lower()
        host = cm_stream.normalize_host(b.get("host") or b.get("url") or "")
        if event not in ("stall", "ok"):
            raise ApiError(400, "event 必须是 stall 或 ok")
        if not cm_stream.is_edge_host(host):
            raise ApiError(400, "host 不是可识别的网易云边缘")
        accepted = cm_stream.health().note(host, event)
        if not accepted:
            raise ApiError(400, "上报未被接受")
        try:
            ncm_id = int(b.get("id") or 0)
        except (TypeError, ValueError):
            ncm_id = 0
        log.info("播放上报 event=%s host=%s song=%s level=%s playedMs=%s bufferedMs=%s",
                 event, host, ncm_id, b.get("level") or "", b.get("playedMs") or 0,
                 b.get("bufferedMs") or 0)
        return jresp(handler, 200, {"ok": True, "host": host, "event": event})

    if path == "/ncm/song/url/health" and method == "GET":
        """CDN 边缘健康度与取证缓存概况（公开只读；不含任何用户信息）。"""
        ip = cm_ncm_gateway.client_ip(handler)
        if rate_limited(ip):
            return jresp(handler, 429, {"error": "操作过于频繁"})
        hosts = cm_stream.health().snapshot()
        return jresp(handler, 200, {
            "edgeHosts": {h: v for h, v in sorted(
                hosts.items(), key=lambda kv: (-kv[1]["stalls"], kv[0]))},
            "edgesVerified": cm_stream.edges().size(),
            "inflight": _resolve_flight.inflight(),
            "policy": {
                "tiers": list(cm_stream.TIERS),
                "probeTiers": list(cm_stream.PROBE_TIERS),
                "nominalBr": cm_stream.NOMINAL_BR,
                "edgeCandidates": list(cm_stream.EDGE_HOSTS),
                "swapMaxAgeS": SWAP_MAX_AGE,
                "urlTtlS": PLAY_URL_TTL,
            },
        })

    # ---- 分享（歌曲 / 歌单 / 歌手 / 专辑，v1.28.49 起；v1.28.68 扩展到多类型）----
    # 客户端仍可本地 canvas 出图；这里为第三方客户端/网页直接提供渲染好的 JPEG。
    if path.startswith("/share/") and method == "GET":
        m = re.fullmatch(r"/share/(song|playlist|local-playlist|artist|album)/([0-9]+)(/image)?", path)
        if not m:
            raise ApiError(400, "分享 id 格式错误")
        kind, oid = m.group(1), int(m.group(2))
        payload = _share_payload(handler, kind, oid)
        if m.group(3):
            try:
                fp = cm_share.ensure_image(payload, payload["url"])
            except cm_share.ShareUnavailable as e:
                raise ApiError(503, str(e))
            return serve_file(handler, fp, "image/jpeg", cache="public, max-age=3600")
        return jresp(handler, 200, payload)

    # ---- 私人漫游（v1.28.69；对齐 CurrentMusicX 1.1.18 的模式/场景协议）----
    if path == "/roaming/catalog" and method == "GET":
        require_user(handler)
        return jresp(handler, 200, {
            "modes": list(ROAMING_MODES),
            "scenes": list(ROAMING_SCENES),
            "source": "builtin",
        })

    if path == "/roaming/songs" and method == "POST":
        _u, cookie = _roaming_binding(handler)
        b = body or {}
        mode = str(b.get("mode") or "DEFAULT").strip().upper()
        allowed = {m["code"] for m in ROAMING_MODES} | {"SCENE_RCMD"}
        if mode not in allowed:
            raise ApiError(400, "不支持的漫游模式")
        sub_mode = str(b.get("subMode") or b.get("submode") or "").strip().upper()
        scene_codes = {s["code"] for s in ROAMING_SCENES}
        if mode == "SCENE_RCMD" and sub_mode not in scene_codes:
            raise ApiError(400, "场景模式需要有效的 subMode")
        try:
            limit = max(1, min(int(b.get("limit") or 20), 30))
        except (TypeError, ValueError):
            raise ApiError(400, "limit 参数错误")
        raw_exclude = b.get("excludeIds") or b.get("exclude_ids") or []
        if isinstance(raw_exclude, str):
            raw_exclude = [x for x in raw_exclude.split(",") if x.strip()]
        exclude_ids = []
        for x in raw_exclude if isinstance(raw_exclude, list) else []:
            try:
                exclude_ids.append(int(x))
            except (TypeError, ValueError):
                continue
        songs = _roaming_songs(cookie, mode, sub_mode, limit, exclude_ids[:200],
                               real_ip=cm_ncm_gateway.client_ip(handler))
        return jresp(handler, 200, {
            "mode": mode, "subMode": sub_mode, "songs": songs,
            "count": len(songs),
        })

    if path == "/roaming/trash" and method == "POST":
        _u, cookie = _roaming_binding(handler)
        b = body or {}
        try:
            ncm_id = int(b.get("id") or b.get("ncmId") or 0)
        except (TypeError, ValueError):
            raise ApiError(400, "id 参数错误")
        if not ncm_id:
            raise ApiError(400, "缺少歌曲 id")
        try:
            d = cm_ncm.call("/fm_trash", {
                "id": ncm_id, "time": int(time.time() * 1000),
            }, cookie=cookie, timeout=15.0, retries=1,
                real_ip=cm_ncm_gateway.client_ip(handler))
        except cm_ncm.NcmError as e:
            raise ApiError(502, f"垃圾桶操作失败：{e}")
        if (d or {}).get("code") not in (None, 200):
            raise ApiError(502, f"网易云返回错误码 {(d or {}).get('code')}")
        return jresp(handler, 200, {"ok": True, "id": ncm_id})

    if path == "/ncm/song/detail" and method == "GET":
        ids = q.get("ids") or ""
        try:
            id_list = [int(i) for i in ids.split(",") if i.strip()][:100]
        except ValueError:
            raise ApiError(400, "ids 参数错误")
        key = f"detail:{','.join(map(str, id_list))}"
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        out = {"songs": cm_ncm.song_detail(id_list)}
        cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), 86400)
        return jresp(handler, 200, out)

    if path == "/ncm/lyric" and method == "GET":
        ncm_id = int(q.get("id") or 0)
        key = f"lyric:v16:{ncm_id}"  # v16：双语合并加误判阈值 + 保留制作名单 + 匹配复核；旧缓存失效
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        # v14 是引入双语合并前的稳定缓存：直接在本机升级格式，
        # 避免升级当天全量歌词 cache miss、把每个用户都拖进 8~10s 的 LDDC 冷请求。
        old = cm_db.cache_get(f"lyric:v14:{ncm_id}")
        if old:
            try:
                out = json.loads(old)
                out["lines"] = cm_lddc.merge_bilingual(out.get("lines") or [])
                out["lines"] = cm_lddc.finalize_lines(out.get("lines") or [])
                cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), cm_lddc.cache_ttl(out))
                return jresp(handler, 200, out)
            except (ValueError, TypeError):
                pass
        out = cm_ncm.lyric(ncm_id)
        cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), cm_lddc.cache_ttl(out))
        return jresp(handler, 200, out)

    # ---- 歌曲百科（v1.28.4）----
    # 上游 /song/wiki/info 是页面级拼装结构，这里归一化成「章节 + 字段 + 正文」再下发；
    # 与歌词同样走 7 天缓存（百科内容几乎不变）。
    if path == "/song/wiki" and method == "GET":
        ncm_id = int(q.get("id") or 0)
        if not ncm_id:
            raise ApiError(400, "缺少 id")
        key = f"wiki:v1:{ncm_id}"
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        out = cm_ncm.song_wiki(ncm_id)
        cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), 7 * 86400)
        return jresp(handler, 200, out)

    if path == "/ncm/comment-count" and method == "GET":
        ncm_id = int(q.get("id") or 0)
        key = f"cc:v2:{ncm_id}"
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        out = cm_ncm.comment_count(ncm_id)
        cm_db.cache_set(key, json.dumps(out), 86400)
        return jresp(handler, 200, out)

    if path == "/ncm/playlist" and method == "GET":
        try:
            pid = int(q.get("id") or 0)
        except ValueError:
            raise ApiError(400, "id 参数错误")
        key = f"ncmpl:{pid}"
        cached = cm_db.cache_get(key)
        if cached:
            return jresp(handler, 200, json.loads(cached))
        d = cm_ncm.call("/playlist/detail", {"id": pid})
        pl = (d or {}).get("playlist") or {}
        ids = [t["id"] for t in (pl.get("trackIds") or [])[:300]]
        out = {
            "id": pl.get("id"), "name": pl.get("name"), "cover": pl.get("coverImgUrl") or "",
            "creator": (pl.get("creator") or {}).get("nickname") or "",
            "description": pl.get("description") or "",
            "trackCount": pl.get("trackCount") or 0,
            "songs": cm_ncm.song_detail(ids[:100]) if ids else [],
        }
        cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), 3600)
        return jresp(handler, 200, out)

    # ---- 在线更新：最新版本信息 + 安装包分发（双源） ----
    if path == "/version/latest" and method == "GET":
        fp = os.path.join(RELEASES_DIR, "latest.json")
        if not os.path.isfile(fp):
            raise ApiError(404, "暂无发布记录")
        with open(fp, "r", encoding="utf-8") as f:
            info = json.load(f)
        fname = info.get("fileName") or f"CurrentMusic-v{info.get('version')}.apk"
        # server 源按当前请求的 host 动态组装，便于任意自建部署
        host = handler.headers.get("Host") or DEFAULT_HOST
        proto = "https" if handler.headers.get("X-Forwarded-Proto") == "https" else "http"
        sources = []
        if os.path.isfile(os.path.join(RELEASES_DIR, fname)):
            sources.append({"key": "server", "label": "服务器直连",
                            "path": f"download/{quote(fname)}",
                            "url": f"{proto}://{host}/cm/download/{quote(fname)}"})
        if info.get("githubUrl"):
            sources.append({"key": "github", "label": "GitHub Releases", "url": info["githubUrl"]})
        out = dict(info)
        out["sources"] = sources
        return jresp(handler, 200, out)

    # 稳定入口：始终指向最新版安装包（网页版「下载安卓版 APP」用，免前端再查版本号）
    if path == "/download/latest" and method == "GET":
        fp = os.path.join(RELEASES_DIR, "latest.json")
        if not os.path.isfile(fp):
            raise ApiError(404, "暂无发布记录")
        with open(fp, "r", encoding="utf-8") as f:
            info = json.load(f)
        fname = info.get("fileName") or f"CurrentMusic-v{info.get('version')}.apk"
        if not os.path.isfile(os.path.join(RELEASES_DIR, fname)):
            raise ApiError(404, "安装包不存在")
        handler.send_response(302)
        handler.send_header("Location", f"/cm/download/{quote(fname)}")   # 浏览器按源解析，需带 /cm 前缀
        handler.send_header("Access-Control-Allow-Origin", "*")           # 允许网页内 fetch 探测（导航下载本不受限）
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return

    m = re.fullmatch(r"/download/([A-Za-z0-9._\-]+\.apk)", path)
    if m and method == "GET":
        fp = os.path.join(RELEASES_DIR, m.group(1))
        if not os.path.isfile(fp):
            raise ApiError(404, "安装包不存在")
        return serve_file(handler, fp, "application/vnd.android.package-archive")

    # ======================== CurrentMusicX 安装包直链（v1.28.23） ========================
    # 上游是第三方仓库（bileizhen/CurrentMusicX）的 GitHub Releases；本机由
    # tools/sync-cmx-releases.py + currentmusic-x-sync.timer 每 3 分钟镜像一次，
    # 于是国内用户拿到的是本域直链，不必直连 GitHub。nginx 会去掉 /cm 前缀：
    #   /cm/x/download/latest   直链，直接回 APK 本体（200，不跳转、不套页面）
    #   /cm/x/download/<file>   指定版本直链（Range/断点续传）
    #   /cm/x/version/latest    版本元数据 JSON（给客户端查最新版用）
    if path == "/x/download/latest" and method == "GET":
        info = {}
        fp = os.path.join(X_RELEASES_DIR, "latest.json")
        if os.path.isfile(fp):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    info = json.load(f)
            except ValueError:
                info = {}
        apk = info.get("apk") or {}
        fname = os.path.basename(apk.get("fileName") or "")
        local = os.path.join(X_RELEASES_DIR, fname) if fname else ""
        if local and os.path.isfile(local):
            # 直接吐文件：第三方下载器/系统更新器不必处理跳转，
            # no-cache 保证「latest」这个地址不会被缓存成旧版本。
            return serve_file(handler, local, "application/vnd.android.package-archive",
                              download_name=fname, cache="no-cache")
        # 镜像尚未就绪（首启、正在下载、上游异常）时退到 GitHub，入口不空转
        if apk.get("githubUrl"):
            handler.send_response(302)
            handler.send_header("Location", apk["githubUrl"])
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.send_header("Cache-Control", "no-cache")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        raise ApiError(404, "镜像尚未同步，请稍后再试")

    if path == "/x/version/latest" and method == "GET":
        fp = os.path.join(X_RELEASES_DIR, "latest.json")
        if not os.path.isfile(fp):
            raise ApiError(404, "镜像尚未同步，请稍后再试")
        try:
            with open(fp, "r", encoding="utf-8") as f:
                info = json.load(f)
        except ValueError:
            raise ApiError(500, "镜像元数据损坏，等待下次同步")
        host = handler.headers.get("Host") or DEFAULT_HOST
        proto = "https" if handler.headers.get("X-Forwarded-Proto") == "https" else "http"
        base = f"{proto}://{host}/cm/x"
        apk = dict(info.get("apk") or {})
        fname = os.path.basename(apk.get("fileName") or "")
        # 「是否已有本地镜像」按磁盘实时判断：同步脚本清理旧包后元数据会滞后一拍
        apk["mirrored"] = bool(fname) and os.path.isfile(os.path.join(X_RELEASES_DIR, fname))
        out = dict(info)
        out["apk"] = apk
        out["mirrored"] = apk["mirrored"]
        out["downloadUrl"] = f"{base}/download/latest"
        out["serverTime"] = int(time.time())
        out["sources"] = [
            {"key": "server", "label": "服务器直连（推荐）",
             "url": f"{base}/download/latest", "mirrored": apk["mirrored"]},
            {"key": "github", "label": "GitHub Releases",
             "url": apk.get("githubUrl") or info.get("releasesUrl") or ""},
        ]
        return jresp(handler, 200, out)

    m = re.fullmatch(r"/x/download/([A-Za-z0-9._\-]+\.apk)", path)
    if m and method == "GET":
        name = os.path.basename(m.group(1))
        fp = os.path.join(X_RELEASES_DIR, name)
        if not os.path.isfile(fp):
            raise ApiError(404, "安装包不存在（可能已被更新的版本替换）")
        return serve_file(handler, fp, "application/vnd.android.package-archive",
                          download_name=name, cache="public, max-age=86400")

    # ---- 播放页「问AI」：私有 SSE，复用 CurrentMusicAI 工具/卡片/上下文 ----
    if path == "/ai/live" and method == "POST":
        u = require_user(handler)
        b = body or {}
        question = str(b.get("question") or "").strip()[:500]
        raw_song = b.get("song")
        song = cm_chat.parse_atts([raw_song]) if isinstance(raw_song, dict) else []
        if not song:
            raise ApiError(400, "缺少歌曲信息")
        if not question:
            question = "请介绍一下这首歌"
        reset = bool(b.get("reset"))
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        handler.close_connection = True      # 有限 SSE：done 后关闭连接，客户端 reader 才会结束
        handler.end_headers()

        def sse(event, payload):
            handler.wfile.write(
                f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
            handler.wfile.flush()

        t0 = time.time()
        try:
            sse("start", {"ok": True})
            ans, cards = cm_ai.answer_player(
                u["id"], question, song, reset=reset,
                on_text=lambda text: sse("delta", {"text": text}))
            sse("done", {"text": ans, "cards": cards})
            log.info("AI 播放页回答 uid=%s song=%s cards=%d 用时=%.1fs",
                     u["id"], song[0].get("id"), len(cards), time.time() - t0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                  # 客户端关闭弹窗：安静收场
        except cm_ai.AiError as e:
            try:
                sse("error", {"error": str(e)})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            log.warning("AI 播放页失败 uid=%s: %s", u["id"], e)
        except Exception as e:  # noqa: BLE001
            try:
                sse("error", {"error": "AI 暂时不可用，请稍后再试"})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            log.warning("AI 播放页异常 uid=%s: %s", u["id"], e)
        return None

    # ---- 公共聊天室（发现页 Chat tab，v1.28.30） ----
    if path == "/chat/messages" and method == "GET":
        return jresp(handler, 200, {"messages": cm_chat.list_messages(
            before=int(q.get("before") or 0), limit=int(q.get("limit") or 30))})

    if path == "/chat/messages" and method == "POST":
        u = require_user(handler)
        if cm_chat.throttled_send(u["id"]):
            raise ApiError(429, "发言太快啦，歇一下")
        b = body or {}
        ok, content = cm_chat.validate_content(b.get("content"))
        image = str(b.get("image") or "")
        if image and not cm_chat.image_path(image):
            raise ApiError(400, "图片引用非法")
        atts = cm_chat.parse_atts((body or {}).get("atts"))
        if not content and not image and not atts:
            raise ApiError(400, "说点什么、带张图，或引用一首歌吧")
        mentions = cm_chat.parse_mentions(b.get("mentions"))
        # 手打 @CurrentMusicAI（没从选择器点选）也识别为提及
        bot = cm_ai.bot_uid()
        if bot and bot not in mentions and f"@{cm_ai.BOT_NICKNAME}" in (content or ""):
            mentions.append(bot)
        sent = cm_chat.send(u, content, image, mentions, atts)
        if cm_ai.should_reply(u, mentions):
            cm_ai.spawn_reply(u, content, atts, image)
        return jresp(handler, 200, sent)

    m = re.fullmatch(r"/chat/messages/(\d+)", path)
    if m and method == "DELETE":
        u = require_user(handler)
        if not cm_chat.delete_message(int(m.group(1)), u):
            raise ApiError(403, "只能删除自己的消息（管理员可删任何人的）")
        return jresp(handler, 200, {"ok": True})

    if path == "/chat/image" and method == "POST":
        u = require_user(handler)
        if cm_chat.throttled_image(u["id"]):
            raise ApiError(429, "图片传得太频繁，稍后再试")
        b = body or {}
        try:
            import base64
            raw = base64.b64decode(str(b.get("file") or ""), validate=False)
        except (ValueError, TypeError):
            raise ApiError(400, "图片数据非法（base64 解码失败）")
        try:
            name = cm_chat.save_image(raw)
        except ValueError as e:
            raise ApiError(400, str(e))
        return jresp(handler, 200, {"image": name, "url": f"/cm/chat/image/{name}"})

    m = re.fullmatch(r"/chat/image/([A-Za-z0-9._\-]+)", path)
    if m and method == "GET":
        fp = cm_chat.image_path(m.group(1))
        if not fp:
            raise ApiError(404, "图片不存在")
        ctype = {"jpg": "image/jpeg", "png": "image/png",
                 "gif": "image/gif", "webp": "image/webp"}.get(fp.rsplit(".", 1)[-1], "application/octet-stream")
        return serve_file(handler, fp, ctype, cache="public, max-age=604800")

    if path == "/chat/members" and method == "GET":
        # ?q= 实时搜索（@ 提及选择器）；不带 q 仍返回近期活跃成员
        term = (q.get("q") or "").strip()[:40]
        if term:
            return jresp(handler, 200, {"members": cm_chat.search_members(
                term, limit=int(q.get("limit") or 8))})
        return jresp(handler, 200, {"members": cm_chat.recent_members(
            limit=int(q.get("limit") or 20))})

    # 聊天实时流：SSE（?sse=1，经 nginx /cm/live/chat 无缓冲命名空间）或 JSON 增量
    if path == "/chat/live" and method == "GET":
        since = int(q.get("since") or 0)
        if q.get("sse") != "1":
            return jresp(handler, 200, {"events": cm_chat.events_since(since),
                                        "latestSeq": cm_chat.latest_seq()})
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("X-Accel-Buffering", "no")     # 让 nginx 不缓冲
        handler.end_headers()
        last = since
        deadline = time.time() + 3600
        try:
            handler.wfile.write(b"retry: 3000\n\n")
            handler.wfile.flush()
            idle = 0.0
            while time.time() < deadline:
                events = cm_chat.events_since(last)
                for e in events:
                    data = json.dumps(e, ensure_ascii=False)
                    handler.wfile.write(
                        f"id: {e['seq']}\nevent: {e['type']}\ndata: {data}\n\n".encode("utf-8"))
                    last = e["seq"]
                if events:
                    handler.wfile.flush()
                    idle = 0.0
                else:
                    idle += 1.5
                    if idle >= 15:                        # 空闲心跳，防中间层掐连接
                        handler.wfile.write(b": ping\n\n")
                        handler.wfile.flush()
                        idle = 0.0
                time.sleep(1.5)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                          # 客户端断开：安静收场
        return None

    # ---- 多人实时听歌房 ----
    if path == "/rooms" and method == "POST":
        u = require_user(handler)
        name = str((body or {}).get("name") or "").strip()[:60]
        if not name:
            raise ApiError(400, "房间名不能为空")
        room = cm_rooms.create_room(
            u["id"], name,
            password=str((body or {}).get("password") or ""),
            is_public=bool((body or {}).get("isPublic", True)),
            free_mode=bool((body or {}).get("freeMode", False)),
            need_approval=bool((body or {}).get("needApproval", True)),
        )
        cm_rooms.emit_event(room["id"], "created", {"roomId": room["id"], "name": name})
        log.info("创建房间 uid=%s room=%s(%s)", u["id"], name, room["code"])
        return jresp(handler, 200, {"room": _room_out(room, u["id"])})

    if path == "/rooms" and method == "GET":
        require_user(handler)
        d = cm_rooms.list_public_rooms(
            q.get("query") or "", min(int(q.get("limit") or 20), 50), max(int(q.get("offset") or 0), 0)
        )
        return jresp(handler, 200, d)

    if path == "/rooms/search" and method == "GET":
        require_user(handler)
        code = (q.get("code") or "").strip()
        if not code:
            raise ApiError(400, "缺少房间号")
        room = cm_rooms.get_room(code=code)
        if not room:
            raise ApiError(404, "房间不存在或已关闭")
        return jresp(handler, 200, {"room": _room_out(room, require_user(handler)["id"], brief=True)})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)", path)
    if m:
        room = _get_room(handler, m.group(1))
        if method == "GET":
            uid = require_user(handler)["id"]
            members = cm_rooms.list_members(room["id"])
            queue = cm_rooms.queue_list(room["id"])
            decors = cm_db.decor_of_users([mm["user_id"] for mm in members])   # 一次查库
            return jresp(handler, 200, {
                "room": _room_out(room, uid),
                "members": [_member_out(mm, decors.get(mm["user_id"], "")) for mm in members],
                "timeline": cm_rooms.get_timeline(room),
                "queue": [_queue_out(i, uid) for i in queue],
                "latestSeq": cm_rooms.get_latest_seq(room["id"]),
                "serverTime": int(time.time() * 1000),
            })

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/join", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        if cm_rooms.is_banned(room["id"], u["id"]):
            raise ApiError(403, "你已被该房间封禁")
        if room["join_locked"]:
            raise ApiError(403, "房间已锁定，暂不接受加入")
        if not cm_rooms.verify_room_password(room, str((body or {}).get("password") or "")):
            raise ApiError(403, "房间密码错误")
        role, joined = cm_rooms.join_room(room["id"], u["id"], u["nickname"], u["avatar"] or "")
        if role is None:
            raise ApiError(409, "房间已满")
        if joined:
            seq = cm_rooms.emit_event(room["id"], "join", {"userId": u["id"], "nickname": u["nickname"]})
        else:
            seq = cm_rooms.get_latest_seq(room["id"])
        room = cm_rooms.get_room(room_id=room["id"])
        return jresp(handler, 200, {
            "role": role,
            "room": _room_out(room, u["id"]),
            "timeline": cm_rooms.get_timeline(room),
            "latestSeq": seq,
            "serverTime": int(time.time() * 1000),
        })

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/leave", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        cm_rooms.leave_room(room["id"], u["id"])
        cm_rooms.emit_event(room["id"], "leave", {"userId": u["id"]})
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/close", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "owner")
        cm_rooms.close_room(room["id"])
        cm_rooms.emit_event(room["id"], "close", {"by": u["id"]})
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/kick", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "admin")
        target_id = int((body or {}).get("userId") or 0)
        if target_id == room["owner_id"]:
            raise ApiError(400, "不能踢出房主")
        cm_rooms.kick_member(room["id"], target_id, u["id"],
                             str((body or {}).get("reason") or ""),
                             bool((body or {}).get("ban")))
        cm_rooms.emit_event(room["id"], "kick", {"userId": target_id, "by": u["id"]})
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/transfer", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "owner")
        target = int((body or {}).get("userId") or 0)
        if not cm_rooms.get_member(room["id"], target):
            raise ApiError(404, "目标不在房间内")
        cm_rooms.set_role(room["id"], target, "owner")
        cm_rooms.set_role(room["id"], u["id"], "admin")
        cm_rooms.emit_event(room["id"], "transfer", {"from": u["id"], "to": target})
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/admins", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "owner")
        target = int((body or {}).get("userId") or 0)
        on = bool((body or {}).get("on", True))
        if not cm_rooms.get_member(room["id"], target):
            raise ApiError(404, "目标不在房间内")
        cm_rooms.set_role(room["id"], target, "admin" if on else "member")
        cm_rooms.emit_event(room["id"], "role", {"userId": target, "role": "admin" if on else "member"})
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/settings", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "owner")
        cm_rooms.update_room_settings(room["id"], body or {})
        cm_rooms.emit_event(room["id"], "settings", body or {})
        return jresp(handler, 200, {"ok": True})

    # ---- 播放控制 ----
    for action in ("play", "pause", "next", "prev"):
        m = re.fullmatch(rf"/rooms/([a-z0-9]+)/{action}", path)
        if m and method == "POST":
            u = require_user(handler)
            room = _get_room(handler, m.group(1))
            _require_role(handler, room, "admin")
            if action == "play":
                pos = int((body or {}).get("position") or 0)
                room = cm_rooms.set_timeline(room["id"], base_position=pos, playing=True, prebuffer=True)
            elif action == "pause":
                elapsed = room["base_position"] + (int(time.time()*1000) - room["base_at"]) if room["playing"] else room["base_position"]
                room = cm_rooms.set_timeline(room["id"], base_position=max(0, elapsed), playing=False)
            elif action in ("next", "prev"):
                item = cm_rooms.queue_pop_next(room["id"])
                if item:
                    from cm_ncm import _norm_song
                    meta = {"ncm_id": item["ncm_id"], "name": item["name"], "artists": item["artists"],
                            "pic": item["pic"], "duration": item["duration"]}
                    try:
                        # 与 /ncm/song/url 同逻辑：auto 先探测最佳档位，再取流
                        # （探测已取到该档位的完整结果时直接复用，不再重复请求上游）。
                        # real_ip 用触发切歌者的 IP——上游据此挑就近 CDN 边缘；此前
                        # 漏传 = 按源站（洛杉矶）选节点，国内房间全员摊上海外线
                        actor_ip = cm_ncm_gateway.client_ip(handler)
                        lv, probed = best_level(item["ncm_id"], real_ip=actor_ip)
                        s = probed or cm_ncm.song_url(item["ncm_id"], lv, real_ip=actor_ip)
                        room = cm_rooms.set_timeline(room["id"], track_ncm_id=item["ncm_id"],
                                                      track_meta=meta, stream_level=s["level"],
                                                      stream_url=s["url"],
                                                      stream_expire_at=int(time.time()*1000)+1100000,
                                                      base_position=0, playing=True, prebuffer=True)
                    except Exception as e:  # noqa: BLE001
                        log.warning("房间切歌解析失败 room=%s song=%s: %s", room["id"], item["ncm_id"], e)
                        room = cm_rooms.set_timeline(room["id"], track_ncm_id=item["ncm_id"],
                                                      track_meta=meta, base_position=0, playing=False)
                else:
                    room = cm_rooms.set_timeline(room["id"], playing=False)
            tl = cm_rooms.get_timeline(room)
            seq = cm_rooms.emit_event(room["id"], action, {"by": u["id"], "timeline": tl})
            return jresp(handler, 200, {"timeline": tl, "seq": seq})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/seek", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "admin")
        pos = max(0, int((body or {}).get("position") or 0))
        room = cm_rooms.set_timeline(room["id"], base_position=pos, playing=room["playing"])
        tl = cm_rooms.get_timeline(room)
        cm_rooms.emit_event(room["id"], "seek", {"by": u["id"], "timeline": tl})
        return jresp(handler, 200, {"timeline": tl})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/stream/renew", path)
    if m and method == "POST":
        require_user(handler)
        room = _get_room(handler, m.group(1))
        if room["track_ncm_id"]:
            try:
                lv = room["stream_level"]
                probed = None
                actor_ip = cm_ncm_gateway.client_ip(handler)   # 续期者 IP：边缘就近（同切歌路径）
                if not lv:
                    lv, probed = best_level(room["track_ncm_id"], real_ip=actor_ip)
                s = probed or cm_ncm.song_url(room["track_ncm_id"], lv, real_ip=actor_ip)
                elapsed = room["base_position"] + (int(time.time()*1000) - room["base_at"]) if room["playing"] else room["base_position"]
                room = cm_rooms.set_timeline(room["id"], stream_url=s["url"], stream_level=s["level"],
                                              stream_expire_at=int(time.time()*1000)+1100000,
                                              base_position=max(0, elapsed))
                tl = cm_rooms.get_timeline(room)
                cm_rooms.emit_event(room["id"], "track", {"timeline": tl})
                return jresp(handler, 200, {"timeline": tl})
            except Exception as e:
                raise ApiError(502, f"续签失败: {e}")
        raise ApiError(400, "当前无曲目")

    # ---- 队列 ----
    m = re.fullmatch(r"/rooms/([a-z0-9]+)/queue", path)
    if m:
        room = _get_room(handler, m.group(1))
        u = require_user(handler)
        member = cm_rooms.get_member(room["id"], u["id"])
        if not member:
            raise ApiError(403, "请先加入房间")
        if method == "GET":
            is_admin = member["role"] in ("owner", "admin")
            items = cm_rooms.queue_list(room["id"], include_pending=is_admin)
            return jresp(handler, 200, {"queue": [_queue_out(i, u["id"]) for i in items]})
        if method == "POST":
            if member.get("muted"):
                raise ApiError(403, "你已被禁言")
            meta = (body or {}).get("meta") or (body or {})
            if not meta.get("ncm_id") or not meta.get("name"):
                raise ApiError(400, "缺少歌曲信息")
            auto = room["free_mode"] or member["role"] in ("owner", "admin")
            item = cm_rooms.queue_add(room["id"], meta, u["id"], auto_approve=auto)
            seq = cm_rooms.emit_event(room["id"], "queue", {"action": "add", "item": _queue_out(item, u["id"])})
            return jresp(handler, 200, {"item": _queue_out(item, u["id"]), "auto": auto})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/queue/(\d+)/(approve|reject)", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        _require_role(handler, room, "admin")
        cm_rooms.queue_review(int(m.group(2)), room["id"], m.group(3) == "approve", u["id"])
        cm_rooms.emit_event(room["id"], "queue", {"action": m.group(3), "qid": int(m.group(2))})
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/queue/(\d+)", path)
    if m and method == "DELETE":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        member = cm_rooms.get_member(room["id"], u["id"])
        if not member:
            raise ApiError(403, "请先加入房间")
        cm_rooms.queue_remove(int(m.group(2)), room["id"])
        cm_rooms.emit_event(room["id"], "queue", {"action": "remove", "qid": int(m.group(2))})
        return jresp(handler, 200, {"ok": True})

    # ---- 信令（SSE / 长轮询） ----
    m = re.fullmatch(r"/rooms/([a-z0-9]+)/events", path)
    if m and method == "GET":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        # 未加入房间的（如广场预览）也允许读取，但不能心跳
        member = cm_rooms.get_member(room["id"], u["id"])
        since = int(q.get("since") or 0)
        if q.get("sse") == "1":
            # ── SSE 长连接：先补发积压事件，再持续推送 ──
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
            handler.send_header("Cache-Control", "no-cache")
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.send_header("X-Accel-Buffering", "no")   # 让 nginx 不缓冲
            handler.end_headers()
            last = since
            deadline = time.time() + 3600
            try:
                handler.wfile.write(f"retry: 3000\n\n".encode("utf-8"))
                handler.wfile.flush()
                while time.time() < deadline:
                    if member:
                        cm_rooms.heartbeat(room["id"], u["id"])
                    events = cm_rooms.get_events_since(room["id"], last)
                    if events:
                        for e in events:
                            data = json.dumps(_event_out(e), ensure_ascii=False)
                            handler.wfile.write(
                                f"id: {e['seq']}\nevent: {e['type']}\ndata: {data}\n\n".encode("utf-8"))
                            last = e["seq"]
                    else:
                        handler.wfile.write(b": ping\n\n")
                    handler.wfile.flush()
                    time.sleep(1.5)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        if q.get("wait"):
            # ── 长轮询：最多挂起 wait 秒，有事件即返回（App 旧版/受限环境回退）──
            wait = min(int(q.get("wait") or 0), 30)
            deadline = time.time() + wait
            while time.time() < deadline:
                if member:
                    cm_rooms.heartbeat(room["id"], u["id"])
                events = cm_rooms.get_events_since(room["id"], since)
                if events:
                    break
                time.sleep(1.0)
        events = cm_rooms.get_events_since(room["id"], since)
        return jresp(handler, 200, {"events": [_event_out(e) for e in events],
                                    "latestSeq": cm_rooms.get_latest_seq(room["id"]),
                                    "serverTime": int(time.time() * 1000)})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/sync", path)
    if m and method == "POST":
        require_user(handler)
        room = _get_room(handler, m.group(1))
        return jresp(handler, 200, {"serverNow": int(time.time() * 1000),
                                    "timeline": cm_rooms.get_timeline(room)})

    m = re.fullmatch(r"/rooms/([a-z0-9]+)/heartbeat", path)
    if m and method == "POST":
        u = require_user(handler)
        room = _get_room(handler, m.group(1))
        cm_rooms.heartbeat(room["id"], u["id"])
        return jresp(handler, 200, {"ok": True, "latestSeq": cm_rooms.get_latest_seq(room["id"])})

    # ---- 管理员面板（均需 is_admin） ----
    if path == "/admin/overview" and method == "GET":
        require_admin(handler)
        out = cm_db.admin_overview()
        try:
            fp = os.path.join(RELEASES_DIR, "latest.json")
            if os.path.isfile(fp):
                with open(fp, "r", encoding="utf-8") as f:
                    rel = json.load(f)
                out["release"] = {"version": rel.get("version"), "versionCode": rel.get("versionCode"),
                                  "publishedAt": rel.get("publishedAt"), "size": rel.get("size")}
        except Exception:  # noqa: BLE001
            pass
        return jresp(handler, 200, out)

    # 管理台「客户端」页：CurrentMusic（本站 APK）与 CurrentMusicX（第三方原生端）
    # 的版本元数据。CurrentMusicX 的 latest.json 由 tools/sync-cmx-releases.py
    # 每 3 分钟从 GitHub Releases 镜像，除版本/大小/时间/更新说明外还带
    # versionCode、minSdk、targetSdk、sha256、下载数与历史版本。
    if path == "/admin/clients" and method == "GET":
        require_admin(handler)

        def _load_release(fp):
            try:
                if os.path.isfile(fp):
                    with open(fp, "r", encoding="utf-8") as f:
                        return json.load(f)
            except (OSError, ValueError):
                pass
            return {}

        cur = _load_release(os.path.join(RELEASES_DIR, "latest.json"))
        cmx = _load_release(os.path.join(X_RELEASES_DIR, "latest.json"))

        cur_file = os.path.basename(cur.get("fileName") or "")
        cur["mirrored"] = bool(cur_file) and os.path.isfile(os.path.join(RELEASES_DIR, cur_file))
        cur["downloadPath"] = "/download/latest"

        xapk = dict(cmx.get("apk") or {})
        x_file = os.path.basename(xapk.get("fileName") or "")
        xapk["mirrored"] = bool(x_file) and os.path.isfile(os.path.join(X_RELEASES_DIR, x_file))
        cmx["apk"] = xapk
        cmx["mirrored"] = xapk["mirrored"]
        cmx["downloadPath"] = "/x/download/latest"
        hist = []
        for h in (cmx.get("history") or [])[:12]:
            h = dict(h)
            hf = os.path.basename(h.get("apkName") or "")
            h["mirrored"] = bool(hf) and os.path.isfile(os.path.join(X_RELEASES_DIR, hf))
            hist.append(h)
        cmx["history"] = hist
        return jresp(handler, 200, {"generatedAt": int(time.time()), "current": cur, "cmx": cmx})

    # 站点出站流量统计（管理员控制台折线图）。日志路径由部署方用 CM_TRAFFIC_LOG
    # 指向 nginx 访问日志；未配置（开源部署默认）返回 available=false，前端显示提示。
    if path == "/admin/traffic" and method == "GET":
        require_admin(handler)
        import cm_traffic
        return jresp(handler, 200, cm_traffic.snapshot(os.environ.get("CM_TRAFFIC_LOG", "")))

    if path == "/admin/users" and method == "GET":
        require_admin(handler)
        try:
            limit = min(int(q.get("limit") or 20), 100)
            offset = max(int(q.get("offset") or 0), 0)
        except ValueError:
            raise ApiError(400, "分页参数错误")
        return jresp(handler, 200, cm_db.admin_list_users(
            q.get("query") or "", limit, offset, q.get("sort") or "reg"))

    m = re.fullmatch(r"/admin/users/(\d+)/(disable|password|kick|admin|title|super|owner)", path)
    if m and method == "POST":
        me = require_admin(handler)
        uid, act = int(m.group(1)), m.group(2)
        if uid == me["id"] and act in ("disable", "admin", "super", "owner"):
            raise ApiError(400, "不能对自己执行该操作")
        target = cm_db.get_user(uid)
        if not target:
            raise ApiError(404, "用户不存在")
        me_rank, tgt_rank = role_rank(me), role_rank(target)
        # 等级保护：不能对等级高于自己的账号动手（站长 > 超管 > 管理员 > 普通用户）
        if tgt_rank > me_rank:
            raise ApiError(403, "不能对等级更高的账号执行该操作")
        if act == "disable":
            on = bool((body or {}).get("on", True))
            cm_db.set_disabled(uid, on)
            log.info("管理员 %s %s 用户 %s(%s)", me["username"], "禁用" if on else "启用", target["username"], uid)
            return jresp(handler, 200, {"ok": True, "disabled": on})
        if act == "password":
            pw = str((body or {}).get("password") or "")
            if not (6 <= len(pw) <= 64):
                raise ApiError(400, "密码长度需 6~64 位")
            import secrets as _s
            salt = _s.token_hex(8)
            conn = cm_db.connect()
            conn.execute("UPDATE users SET pass_hash=?, salt=?, token_hash='' WHERE id=?",
                         (cm_db.hash_password(pw, salt), salt, uid))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            conn.commit()
            conn.close()
            log.info("管理员 %s 重置了用户 %s(%s) 的密码", me["username"], target["username"], uid)
            return jresp(handler, 200, {"ok": True})
        if act == "kick":
            conn = cm_db.connect()
            cur = conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            conn.commit()
            conn.close()
            log.info("管理员 %s 踢下线用户 %s(%s) 共 %s 个会话", me["username"], target["username"], uid, cur.rowcount)
            return jresp(handler, 200, {"ok": True, "kicked": cur.rowcount})
        if act == "admin":
            on = bool((body or {}).get("on", True))
            cm_db.set_admin(uid, on)
            log.info("管理员 %s %s 用户 %s(%s) 的管理员权限",
                     me["username"], "授予" if on else "取消", target["username"], uid)
            return jresp(handler, 200, {"ok": True, "isAdmin": on})
        if act == "title":
            # 头衔：管理员/超管/站长都可授予，但不能改等级比自己高的账号（上面的等级保护已拦）
            raw = str((body or {}).get("title") or "")
            t = cm_db.clean_title(raw)
            if len(t) > cm_db.TITLE_MAX:
                raise ApiError(400, f"头衔最多 {cm_db.TITLE_MAX} 字")
            t = cm_db.set_title(uid, t)
            log.info("管理员 %s 将用户 %s(%s) 的头衔设为「%s」", me["username"], target["username"], uid, t)
            return jresp(handler, 200, {"ok": True, "title": t})
        if act == "super":
            # 超级管理员：超管与站长可授予/取消；不能取消最后一位超管（防锁死）
            if me_rank < 1:
                raise ApiError(403, "只有超级管理员可以设置超级管理员")
            on = bool((body or {}).get("on", True))
            if not on:
                conn = cm_db.connect()
                n = conn.execute("SELECT COUNT(*) FROM users WHERE is_super=1").fetchone()[0]
                conn.close()
                if n <= 1:
                    raise ApiError(400, "至少保留一位超级管理员")
            cm_db.set_super(uid, on)
            log.info("超管 %s %s 用户 %s(%s) 的超级管理员权限",
                     me["username"], "授予" if on else "取消", target["username"], uid)
            return jresp(handler, 200, {"ok": True, "isSuper": on})
        if act == "owner":
            # 站长是最高角色：只有站长能授予/取消，且至少保留一位（防锁死）
            if me_rank < 2:
                raise ApiError(403, "只有站长可以设置站长")
            on = bool((body or {}).get("on", True))
            if not on:
                conn = cm_db.connect()
                n = conn.execute("SELECT COUNT(*) FROM users WHERE is_owner=1").fetchone()[0]
                conn.close()
                if n <= 1:
                    raise ApiError(400, "至少保留一位站长")
            cm_db.set_owner(uid, on)
            log.info("站长 %s %s 用户 %s(%s) 的站长角色",
                     me["username"], "授予" if on else "取消", target["username"], uid)
            return jresp(handler, 200, {"ok": True, "isOwner": on})

    if path == "/admin/sessions" and method == "GET":
        require_admin(handler)
        return jresp(handler, 200, {"sessions": cm_db.admin_all_sessions(100)})

    if path == "/admin/cache/clear" and method == "POST":
        require_admin(handler)
        scope = str((body or {}).get("scope") or "aux")     # aux=歌词/评论/详情缓存（不动音质档位缓存）
        conn = cm_db.connect()
        if scope == "all":
            cur = conn.execute("DELETE FROM cache")
        else:
            cur = conn.execute("DELETE FROM cache WHERE k LIKE 'lyric:%' OR k LIKE 'comments:%'"
                               " OR k LIKE 'cfloor:%' OR k LIKE 'cc:%' OR k LIKE 'detail:%'"
                               " OR k LIKE 'daily:%' OR k LIKE 'hot:%' OR k LIKE 'foryou:%'"
                               " OR k LIKE 'ncmpl:%'")
        conn.commit()
        conn.close()
        log.info("管理员 %s 清理缓存 scope=%s 共 %s 条", me_username(handler), scope, cur.rowcount)
        return jresp(handler, 200, {"ok": True, "cleared": cur.rowcount})

    # ---- 封面图片代理（跨域取色兜底：canvas 需要 same-origin） ----
    # 投屏歌词：LRC 纯文本（DLNA 设备按 CaptionInfo/subtitle 拉取时用它）。
    # 翻译行按同一时间戳追加一行（多数播放器会顺次显示），无翻译则只有原文。
    m = re.fullmatch(r"/cast/(\d+)\.lrc", path)
    if m and method == "GET":
        ncm_id = int(m.group(1))
        key = f"castlrc:{ncm_id}"
        cached = cm_db.cache_get(key)
        if cached is None:
            try:
                d = cm_ncm.lyric(ncm_id)
            except Exception:  # noqa: BLE001
                d = {"lines": []}
            rows = []
            for ln in d.get("lines") or []:
                t = int(ln.get("t") or 0)
                txt = str(ln.get("txt") or "").strip()
                if not txt:
                    continue
                mm, ss = divmod(t // 1000, 60)
                stamp = f"[{mm:02d}:{ss:02d}.{t % 1000 // 10:02d}]"
                rows.append(stamp + txt)
                tr = str(ln.get("trans") or "").strip()
                if tr and tr != txt:
                    rows.append(stamp + tr)
            cached = "\n".join(rows)
            cm_db.cache_set(key, cached, 7 * 86400)
        body = cached.encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "text/plain; charset=utf-8")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("Cache-Control", "public, max-age=86400")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        if not getattr(handler, "head_only", False):
            handler.wfile.write(body)
        return

    # ---- DLNA 投屏：音频中转（渲染器只认普通 http + Range，见 cm_cast.py 注释）----
    m = re.fullmatch(r"/cast/(\d+)", path)
    is_head = getattr(handler, "head_only", False)      # _run 把 HEAD 映射为 GET，故看标记
    if m and (method == "GET" or is_head):
        ncm_id = int(m.group(1))
        level = q.get("level") or "auto"
        if level != "auto" and level not in VALID_LEVELS:
            level = "lossless"

        # 预热：永远只回 JSON（即便已缓存也如此），供 App 打开设备列表时提前解析音源。
        # v1.28.33：这是「换取投屏地址」的唯一入口 → 必须登录；返回带签名的短链，
        # 设备（电视/音箱）凭签名拉流，不需要也发不出 Bearer。
        if q.get("warm"):
            require_user(handler)
            try:
                url_, ext_, lv_ = cast_resolve(ncm_id, None if level == "auto" else level)
            except Exception as e:  # noqa: BLE001
                raise ApiError(502, f"音源获取失败: {e}")
            exp, sig = cm_cast.sign_cast(ncm_id, level)
            base = f"{'https' if handler.headers.get('X-Forwarded-Proto') == 'https' else 'http'}://" \
                   f"{handler.headers.get('Host') or DEFAULT_HOST}"
            return jresp(handler, 200, {"ok": True, "level": lv_, "ext": ext_,
                                        "url": f"{base}/cm/cast/{ncm_id}"
                                               f"?level={quote(str(level))}&exp={exp}&sig={sig}",
                                        "expiresAt": exp})

        # 音源仅限注册用户：设备请求必须带有效签名（过期/篡改一律 401）
        if not cm_cast.verify_cast(ncm_id, level, q.get("exp"), q.get("sig")):
            raise ApiError(401, "投屏地址无效或已过期，请重新在 App 内发起投屏")

        fp = cm_cast.find_cached(ncm_id)
        if not fp:
            # 未完整缓存：先解析音源地址（带缓存，避免渲染器重连时反复探测档位而超时）
            try:
                url_, ext_, lv_ = cast_resolve(ncm_id, None if level == "auto" else level)
            except Exception as e:  # noqa: BLE001
                raise ApiError(502, f"音源获取失败: {e}")
            cm_cast.drop_job(ncm_id)            # 上次失败的任务要丢掉才能重试
            job = cm_cast.ensure_job(ncm_id, url_, ext_)
            ctype = cm_cast.mime_of(ext_)
            if job is None:                     # 竞态：刚好被别人下完
                fp = cm_cast.find_cached(ncm_id)
            else:
                if is_head:
                    # 只报告元信息，不阻塞（设备常先 HEAD 探测）
                    avail, total_, done_, err_ = job.snapshot()
                    size_ = total_ if total_ > 0 else avail
                    handler.send_response(200 if err_ is None else 502)
                    handler.send_header("Content-Type", ctype)
                    handler.send_header("Accept-Ranges", "bytes")
                    handler.send_header("Content-Length", str(max(0, size_)))
                    handler.send_header("Cache-Control", "no-store")
                    handler.end_headers()
                    return
                if not _cast_sem.acquire(blocking=False):
                    raise ApiError(503, "投屏并发数已达上限，请稍后再试")
                try:
                    _serve_job(handler, job)
                finally:
                    _cast_sem.release()
                return

        if not fp:
            raise ApiError(502, "音频缓存不可用")

        # 已完整缓存：走本地文件（支持 Range，电视拖进度必需）
        size = os.path.getsize(fp)
        ext = os.path.splitext(fp)[1].lstrip(".")
        ctype = cm_cast.mime_of(ext)
        rng = handler.headers.get("Range") or ""
        start_b, end_b = 0, size - 1
        partial = False
        mr = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
        if mr:
            partial = True
            if mr.group(1):
                start_b = int(mr.group(1))
                if mr.group(2):
                    end_b = min(int(mr.group(2)), size - 1)
            else:                                   # bytes=-N：最后 N 字节
                n = int(mr.group(2) or 0)
                start_b = max(0, size - n)
            if start_b > end_b or start_b >= size:
                handler.send_response(416)
                handler.send_header("Content-Range", f"bytes */{size}")
                handler.send_header("Content-Length", "0")
                handler.end_headers()
                return
        length = end_b - start_b + 1
        handler.send_response(206 if partial else 200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Accept-Ranges", "bytes")
        handler.send_header("Content-Length", str(length))
        if partial:
            handler.send_header("Content-Range", f"bytes {start_b}-{end_b}/{size}")
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        if is_head:
            return
        with open(fp, "rb") as f:
            f.seek(start_b)
            left = length
            while left > 0:
                chunk = f.read(min(256 * 1024, left))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                left -= len(chunk)
        return


    if path == "/img" and method == "GET":
        target = q.get("url") or ""
        try:
            data, ctype = cm_net.fetch(target, allowed_suffixes=("music.126.net",),
                                       timeout=10.0, max_bytes=6 * 1024 * 1024)
        except cm_net.FetchError as e:
            raise ApiError(400, str(e))
        if not ctype.startswith("image/"):
            raise ApiError(502, "目标不是图片")
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Cache-Control", "public, max-age=86400")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return

    # ---- 评论区（列表公开；发送/删除走绑定账号） ----
    if path == "/ncm/comments" and method == "GET":
        try:
            ncm_id = int(q.get("id") or 0)
        except ValueError:
            raise ApiError(400, "id 参数错误")
        offset = max(int(q.get("offset") or 0), 0)
        limit = min(int(q.get("limit") or 20), 50)
        key = f"comments:{ncm_id}:{offset}:{limit}"
        cached = cm_db.cache_get(key)
        if cached:
            out = json.loads(cached)
        else:
            out = cm_ncm.comment_list(ncm_id, offset, limit)
            cm_db.cache_set(key, json.dumps(out, ensure_ascii=False), 120)
        # 附带绑定账号 uid，前端用于标记/删除自己的评论
        out = dict(out)
        try:
            u = require_user(handler)
            b = cm_db.get_binding(u["id"])
            out["meUid"] = (b or {}).get("ncm_uid") or 0
        except ApiError:
            out["meUid"] = 0
        return jresp(handler, 200, out)

    m = re.fullmatch(r"/ncmbind/comment/(\d+)", path)
    if m and method in ("POST", "DELETE"):
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b:
            raise ApiError(400, "发评/删评需先绑定网易云账号")
        ncm_id = int(m.group(1))
        if method == "POST":
            content = str((body or {}).get("content") or "").strip()[:140]
            if not content:
                raise ApiError(400, "评论内容不能为空")
            cm_ncm.comment_post(b["cookie"], ncm_id, content, (body or {}).get("commentId"),
                                real_ip=cm_ncm_gateway.client_ip(handler))
            log.info("网易云评论 uid=%s song=%s reply=%s", u["id"], ncm_id, bool((body or {}).get("commentId")))
        else:
            cid = int((body or {}).get("commentId") or 0)
            if not cid:
                raise ApiError(400, "缺少 commentId")
            cm_ncm.comment_delete(b["cookie"], ncm_id, cid,
                                  real_ip=cm_ncm_gateway.client_ip(handler))
        conn = cm_db.connect()
        conn.execute("DELETE FROM cache WHERE k LIKE ?", (f"comments:{ncm_id}:%",))
        conn.commit()
        conn.close()
        return jresp(handler, 200, {"ok": True})

    m = re.fullmatch(r"/ncmbind/comment-like/(\d+)", path)
    if m and method == "POST":
        """点赞/取消点赞一条网易云评论（走绑定账号）。"""
        u = require_user(handler)
        b = cm_db.get_binding(u["id"])
        if not b:
            raise ApiError(400, "点赞评论需先绑定网易云账号")
        ncm_id = int(m.group(1))
        cid = int((body or {}).get("commentId") or 0)
        like = bool((body or {}).get("like", True))
        if not cid:
            raise ApiError(400, "缺少 commentId")
        try:
            cm_ncm.comment_like(b["cookie"], ncm_id, cid, like,
                                real_ip=cm_ncm_gateway.client_ip(handler))
        except cm_ncm.NcmError as e:
            raise ApiError(502, str(e))
        for k in (f"comments:{ncm_id}:%", f"cfloor:{cid}:%"):
            conn = cm_db.connect()
            conn.execute("DELETE FROM cache WHERE k LIKE ?", (k,))
            conn.commit()
            conn.close()
        return jresp(handler, 200, {"ok": True, "liked": like})

    # ---- 每日推荐 ----
    if path == "/daily" and method == "GET":
        try:
            u = require_user(handler)
        except ApiError:
            u = None
        return jresp(handler, 200, _payload_daily(u))

    # ---- T3 专用入口（在泛化转发之前拦截）----
    # 上游的登录/验证码/注册/换绑/设置类接口属 T3：**禁止**经登记表泛化转发
    # （那等于让任何登录用户拿任意参数去打风控接口），只能在这里显式实现。
    if path in _T3_ROUTES:
        return _ncm_t3(handler, method, path, q, body)

    # ---- NCM 上游泛化转发（登记表驱动；未登记返回 None 落到 404）----
    if path.startswith("/ncm/"):
        handled = _ncm_forward(handler, method, path, q, body)
        if handled is not None:
            return handled

    raise ApiError(404, f"未知接口 {method} {path}")


class _HeadWriter:
    """HEAD 响应专用写代理：状态行与响应头照常发出，仅丢弃正文。

    注意不能把 wfile 整个换成丢弃器——BaseHTTPRequestHandler 的 status line 与 header
    也是写 wfile 的，全丢会导致上游收到空响应（nginx 报 502）。
    做法：end_headers() 之前照透传，之后（即正文阶段）丢弃。
    """

    def __init__(self, real):
        self._real = real
        self._body = False

    def write(self, b):
        if self._body:
            return len(b)
        return self._real.write(b)

    def flush(self):
        try:
            self._real.flush()
        except Exception:
            pass

    def close(self):
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "CurrentMusic/1.0"

    def end_headers(self):
        # 所有后端响应（JSON/HTML/图片/SSE）统一安全头；静态 /app/ 由 nginx 另加。
        for k, v in (
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "SAMEORIGIN"),
            ("Referrer-Policy", "strict-origin-when-cross-origin"),
            ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
        ):
            self.send_header(k, v)
        super().end_headers()

    def _run(self, method):
        # HEAD 语义 = 与 GET 同样的响应头、但不带响应体。BaseHTTPRequestHandler 不会自动
        # 抑制响应体，故这里把 wfile 换成一个丢弃写入的包装（Content-Length 仍如实声明）。
        if method == "HEAD":
            real = self.wfile
            self.wfile = _HeadWriter(real)
            self.head_only = True
            try:
                self._dispatch("GET")
            finally:
                self.wfile = real
            return
        self._dispatch(method)

    def _dispatch(self, method):
        try:
            route(self, method)
        except ApiError as e:
            jresp(self, e.code, {"error": e.msg})
        except cm_passport.PassportError as e:
            # 通行证协议错误：按 OAuth 的 error/error_description 形状返回（第三方据此分支）
            jresp(self, e.status, {"error": e.error, "error_description": e.desc})
        except cm_ncm.NcmError as e:
            jresp(self, 502, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("内部错误 %s %s", method, self.path)
            jresp(self, 500, {"error": f"服务器内部错误: {e}"})

    def do_GET(self):
        self._run("GET")

    def do_HEAD(self):
        # 部分 DLNA 渲染器会先 HEAD 探测（拿 Content-Length / Content-Type / Accept-Ranges）；
        # 不支持 HEAD 时它们可能直接放弃播放，故与 GET 同路由、仅不写响应体。
        self._run("HEAD")

    def do_POST(self):
        self._run("POST")

    def do_PUT(self):
        self._run("PUT")

    def do_DELETE(self):
        self._run("DELETE")

    def end_headers(self):
        super().end_headers()
        w = self.wfile
        if isinstance(w, _HeadWriter):
            w._body = True      # 响应头已发出，后面写的一定是正文

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):  # 精简访问日志
        log.info("%s %s %s", self.client_address[0], self.command, self.path.split("?")[0])


def _cache_housekeeping():
    """启动时清一次过期缓存，之后每 6 小时清一次（表不会自缩，避免白占磁盘/页缓存）。"""
    while True:
        try:
            n = cm_db.cache_purge_expired()
            if n:
                log.info("已清理过期缓存 %d 条", n)
        except Exception as e:  # noqa: BLE001 清理失败不能影响服务
            log.warning("清理过期缓存失败: %s", e)
        time.sleep(6 * 3600)


def main():
    cm_db.init()
    _rc = cm_db.connect()
    cm_rooms.init_room_tables(_rc)
    cm_chat.init_chat_tables(_rc)
    cm_region.init_region_tables(_rc)
    cm_ai.ensure_bot(AVATAR_DIR)
    _rc.close()
    os.makedirs(AVATAR_DIR, exist_ok=True)
    os.makedirs(cm_cast.CACHE_DIR, exist_ok=True)
    cm_cast.cleanup_stale_parts()
    threading.Thread(target=_cache_housekeeping, name="cm-cache-housekeeping",
                     daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log.info("CurrentMusic 后端启动 %s:%s db=%s", HOST, PORT, cm_db.DB_PATH)
    srv.serve_forever()


if __name__ == "__main__":
    main()
