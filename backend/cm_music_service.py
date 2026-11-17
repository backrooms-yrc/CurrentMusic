"""Versioned, declarative music-service API for independently connected clients."""
from dataclasses import dataclass
from html import escape
import json
import os
import re
from urllib.parse import urlencode, urlsplit

import cm_db
import cm_ncm
import cm_passport
import cm_qq
import cm_qq_catalog

PREFIX = "/music-service"
VERSION = 1
X_CONNECT = "https://currentmusicx.bileizhen.top/connect"
X_CALLBACK = X_CONNECT + "/callback"
CLIENT_ENV = "CM_MUSIC_SERVICE_CLIENT_ID"
DEFAULT_CLIENT_ID = "cs_app_currentmusicx_music_service"
MEDIA_ENV = "CM_MUSIC_SERVICE_MEDIA"
LEVELS = ("standard", "higher", "exhigh", "lossless", "hires", "sky", "jyeffect", "jymaster", "dolby", "vivid")
ID = re.compile(r"[A-Za-z0-9_-]{1,80}")


class Error(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


@dataclass(frozen=True)
class Operation:
    label: str
    run: object
    scope: str = ""
    providers: tuple = ("netease",)
    media: str = ""
    write: bool = False


def issuer(origin):
    return origin.rstrip("/") + "/cm"


def app(origin):
    client_id = os.environ.get(CLIENT_ENV, DEFAULT_CLIENT_ID).strip()
    entry = cm_db.passport_app_get(client_id) if origin.startswith("https://") and client_id else None
    return entry if (entry and not entry["disabled"] and not entry["secret_hash"]
                     and X_CALLBACK in json.loads(entry["redirects"])) else None


def media_enabled(name):
    return not name or name in {scope.strip() for scope in os.environ.get(MEDIA_ENV, "").split(",")}


def descriptor(origin):
    client = app(origin)
    usable_scopes = set(cm_passport.scope_names(client["scopes"])) if client else set()
    platforms = {}
    for provider in ("netease", "qqmusic"):
        if provider == "qqmusic" and not cm_qq.BASE:
            continue
        platforms[provider] = [
            {"id": key, "label": op.label, "scope": op.scope or None, "write": op.write}
            for key, op in OPERATIONS.items()
            if provider in op.providers and media_enabled(op.media) and (not op.scope or op.scope in usable_scopes)
        ]
    base = issuer(origin)
    return {
        "format": "currentmusic.music-service",
        "version": VERSION,
        "id": "currentmusic-engine",
        "name": "流声引擎",
        "apiBase": base + PREFIX + "/v1",
        "platforms": platforms,
        "authorization": {
            "issuer": base,
            "clientId": client["key"],
            "authorizeUrl": origin + "/app/#/passport/authorize",
            "tokenUrl": base + "/passport/token",
            "revokeUrl": base + "/passport/revoke",
        } if client else None,
    }


def connection_page(origin):
    profile = issuer(origin) + PREFIX + "/descriptor"
    link = X_CONNECT + "?" + urlencode({"descriptor": profile})
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>连接流声引擎</title>
<main><h1>连接流声引擎</h1>
<p>在流声音乐里确认连接。需要个人音乐权限时，浏览器会打开本服务的授权页。</p>
<p><a href="{escape(link, quote=True)}">在流声音乐中连接</a></p>
<p><a href="/api-docs/reference/guide-music-service-api/">接入文档</a></p>
</main></html>"""


def error(status, code, message):
    raise Error(status, code, message)


def string(data, name, limit=200, *, default=""):
    value = data.get(name, default)
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        error(400, "invalid_input", f"{name} 格式错误")
    return value.strip()


def integer(data, name, lo, hi, default=None):
    value = data.get(name, default)
    if type(value) is not int or not lo <= value <= hi:
        error(400, "invalid_input", f"{name} 超出允许范围")
    return value


def reference(data, name="id"):
    value = string(data, name, 80)
    if not ID.fullmatch(value):
        error(400, "invalid_input", f"{name} 格式错误")
    return value


def ncm_id(data, name="id"):
    value = reference(data, name)
    if not value.isascii() or not value.isdigit() or not 0 < int(value) <= 2**63 - 1:
        error(400, "invalid_input", f"{name} 须为正整数 ID 字符串")
    return int(value)


def paging(data):
    return integer(data, "offset", 0, 1000, 0), integer(data, "limit", 1, 50, 30)


def public_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 for c in value):
        return ""
    try:
        url = urlsplit(value)
        return value if url.scheme == "https" and url.hostname and not url.username and not url.password else ""
    except ValueError:
        return ""


def resource(row, kind="song"):
    ident = row.get("ncm_id") or row.get("id")
    if not ident:
        return None
    duration = row.get("duration")
    return {
        "id": str(ident), "kind": kind, "name": str(row.get("name") or "")[:300],
        "artists": str(row.get("artists") or row.get("artist") or "")[:300],
        "album": str(row.get("album") or "")[:300],
        "artwork": public_url(row.get("pic") or row.get("cover") or row.get("coverImgUrl")),
        "durationMs": max(0, duration) if type(duration) is int else 0,
        "videoId": str(row["mv"]) if row.get("mv") else "",
    }


def resources(rows, kind="song"):
    return [item for row in rows if isinstance(row, dict) and (item := resource(row, kind))]


def page(items, offset=0, more=False):
    return {"items": items, "nextOffset": offset + len(items) if more and items else None}


def qq(path, query):
    return cm_qq_catalog.read(path, query, None, cm_qq.call, cm_qq.Error)


def search(provider, data, _uid, ip):
    query = string(data, "query", 60)
    kind = string(data, "kind", 15, default="song")
    if not query or kind not in ("song", "artist", "album", "playlist"):
        error(400, "invalid_input", "需要有效的搜索词和资源类型")
    offset, limit = paging(data)
    result = (cm_ncm.search_types(query, (kind,), limit=limit, offset=offset, real_ip=ip) if provider == "netease"
              else qq("/search", {"keywords": query, "type": kind, "offset": offset, "limit": limit}))
    key = kind + "s"
    return page(resources(result.get(key, []), kind), offset, result["hasMore"].get(kind, False))


def details(kind):
    def run(provider, data, _uid, _ip):
        ident = str(ncm_id(data)) if provider == "netease" else reference(data)
        if kind == "song":
            rows = cm_ncm.song_detail([ident]) if provider == "netease" else qq("/song/detail", {"ids": ident})["songs"]
            items = resources(rows)
            if not items:
                error(404, "not_found", "歌曲不存在")
            return {"resource": items[0]}
        offset, limit = paging(data)
        if provider == "qqmusic":
            result = qq("/" + kind, {"id": ident, "offset": offset, "limit": limit})
        elif kind == "album":
            result = cm_ncm.album_songs(ident)
        elif kind == "artist":
            result = cm_ncm.artist_works(ident, limit, offset)
        else:
            result = cm_ncm.playlist_full("", ident)
        tracks = resources(result.get("songs", []))
        if kind != "artist":
            tracks, more = tracks[offset:offset + limit], len(tracks) > offset + limit
        else:
            more = result.get("more", result.get("hasMore", False))
        return {
            "resource": resource({**result, "id": ident}, kind),
            "tracks": tracks, "albums": resources(result.get("albums", []), "album"),
            "nextOffset": offset + len(tracks) if more and tracks else None,
        }
    return run


def hot(_provider, _data, _uid, _ip):
    return {"items": [h["name"] for h in cm_ncm.search_hot()]}


def suggest(_provider, data, _uid, ip):
    query = string(data, "query", 60)
    if not query:
        error(400, "invalid_input", "需要搜索词")
    reply = cm_ncm.call("/search/suggest", {"keywords": query, "type": "mobile"}, with_cookie=False, real_ip=ip)
    return {"items": [str(row.get("keyword") or "") for row in (reply.get("result") or {}).get("allMatch", [])][:20]}


def charts(_provider, _data, _uid, _ip):
    reply = cm_ncm.call("/toplist", with_cookie=False)
    return page(resources(reply.get("list", []), "playlist"))


def binding(uid):
    bound = cm_db.get_binding(uid)
    if not bound or not bound["cookie"] or bound.get("stale"):
        error(403, "binding_required", "请在服务网页绑定或重新连接网易云账号")
    return bound["cookie"]


def recommendation(_provider, _data, uid, ip):
    reply = cm_ncm.call("/recommend/songs", cookie=binding(uid), real_ip=ip)
    return page(resources([cm_ncm._norm_song(row) for row in (reply.get("data") or {}).get("dailySongs", [])]))


def lyrics(provider, data, _uid, _ip):
    return (cm_ncm.lyric(ncm_id(data)) if provider == "netease"
            else qq("/lyric", {"id": reference(data)}))


def comments(_provider, data, _uid, _ip):
    sort = string(data, "sort", 12, default="hot")
    if sort not in cm_ncm.COMMENT_SORTS:
        error(400, "invalid_input", "不支持的评论排序")
    return cm_ncm.comment_page(ncm_id(data), 0, sort, integer(data, "page", 1, 500, 1),
                               integer(data, "limit", 1, 50, 20), string(data, "cursor", 120) or None,
                               cookie="")


def comment_add(_provider, data, uid, ip):
    text = string(data, "text", 300)
    if not text:
        error(400, "invalid_input", "评论不能为空")
    return {"ok": bool(cm_ncm.comment_post(binding(uid), ncm_id(data), text, real_ip=ip))}


def qualities(_provider, data, uid, _ip):
    ncm_id(data)
    binding(uid)
    return {"levels": list(LEVELS)}


def play(_provider, data, uid, ip):
    ident = ncm_id(data)
    level = string(data, "quality", 16, default="auto")
    if level != "auto" and level not in LEVELS:
        error(400, "invalid_input", "不支持的音质")
    cookie = binding(uid)
    if level == "auto":
        level = "jymaster"
    reply = cm_ncm.call("/song/url/v1", {"id": ident, "level": level}, cookie=cookie,
                        real_ip=ip, bypass_cache=True, timeout=8, retries=0)
    rows = reply.get("data") or []
    audio = next((row for row in rows if str(row.get("id")) == str(ident)), {})
    url = public_url(cm_ncm._https(audio.get("url")))
    if reply.get("code") != 200 or not url or audio.get("freeTrialInfo") is not None or audio.get("code") != 200:
        error(403, "playback_unavailable", "当前曲目或音质不可播放，可能受账号或地区权限限制")
    return {"url": url, "quality": audio.get("level") or "", "format": audio.get("type") or "",
            "bitrate": audio.get("br") or 0, "expiresIn": audio.get("expi") or 60}


def mv(_provider, data, uid, ip):
    reply = cm_ncm.call("/mv/url", {"id": ncm_id(data)}, cookie=binding(uid), real_ip=ip, bypass_cache=True)
    result = reply.get("data") or {}
    url = public_url(cm_ncm._https(result.get("url")))
    if reply.get("code") != 200 or not url or result.get("fee") or result.get("freeTrialInfo"):
        error(403, "playback_unavailable", "当前 MV 不可播放")
    return {"url": url, "format": "mp4", "expiresIn": 60}


def download(_provider, data, uid, ip):
    ident = ncm_id(data)
    level = string(data, "quality", 16, default="auto")
    if level != "auto" and level not in LEVELS:
        error(400, "invalid_input", "不支持的音质")
    reply = cm_ncm.call("/song/download/url/v1", {"id": ident, "level": "lossless" if level == "auto" else level},
                        cookie=binding(uid), real_ip=ip, bypass_cache=True, timeout=8, retries=0)
    result = reply.get("data") or {}
    url = public_url(cm_ncm._https(result.get("url")))
    if (reply.get("code") != 200 or result.get("code") != 200 or not url
            or str(result.get("id")) != str(ident) or result.get("freeTrialInfo") is not None):
        error(403, "download_unavailable", "当前账号或曲目不允许下载")
    return {"url": url, "quality": result.get("level") or "", "format": result.get("type") or "",
            "bitrate": result.get("br") or 0, "expiresIn": result.get("expi") or 60}


def favorites(_provider, data, uid, _ip):
    offset, limit = paging(data)
    ids = cm_db.like_ids(uid, table="favs", limit=offset + limit + 1)
    rows = cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids[offset:offset + limit]))
    return page(resources(rows), offset, len(ids) > offset + limit)


def favorite_set(_provider, data, uid, _ip):
    ident, selected = ncm_id(data), data.get("selected")
    if type(selected) is not bool:
        error(400, "invalid_input", "selected 须为布尔值")
    if selected:
        save_tracks([ident])
    cm_db.set_favorite(uid, ident, selected)
    return {"selected": selected}


def save_tracks(ids):
    for track in cm_ncm.song_detail(ids):
        if track.get("ncm_id"):
            cm_db.upsert_song(track)


def user_playlists(_provider, data, uid, _ip):
    offset, limit = paging(data)
    rows = cm_db.playlists_of(uid)
    return page(resources(rows[offset:offset + limit], "playlist"), offset, len(rows) > offset + limit)


def owned_playlist(data, uid):
    playlist = cm_db.get_playlist(ncm_id(data))
    if not playlist or playlist["user_id"] != uid:
        error(404, "not_found", "歌单不存在")
    return playlist


def user_playlist(_provider, data, uid, _ip):
    playlist = owned_playlist(data, uid)
    offset, limit = paging(data)
    ids = cm_db.playlist_track_ids(playlist["id"])
    tracks = resources(cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids[offset:offset + limit])))
    return {"resource": resource(playlist, "playlist"), "tracks": tracks,
            "nextOffset": offset + len(tracks) if len(ids) > offset + limit and tracks else None}


def playlist_create(_provider, data, uid, _ip):
    name = string(data, "name", 100)
    if not name:
        error(400, "invalid_input", "需要歌单名称")
    ident = cm_db.create_playlist(uid, name, string(data, "description", 300))
    return {"resource": resource(cm_db.get_playlist(ident), "playlist")}


def playlist_edit(_provider, data, uid, _ip):
    playlist = owned_playlist(data, uid)
    name = string(data, "name", 100)
    if not name:
        error(400, "invalid_input", "需要歌单名称")
    fields = {"name": name}
    if "description" in data:
        fields["description"] = string(data, "description", 300)
    cm_db.update_playlist(playlist["id"], fields)
    return {"resource": resource(cm_db.get_playlist(playlist["id"]), "playlist")}


def playlist_delete(_provider, data, uid, _ip):
    cm_db.delete_playlist(owned_playlist(data, uid)["id"])
    return {"ok": True}


def playlist_tracks(_provider, data, uid, _ip):
    playlist = owned_playlist(data, uid)
    ids = data.get("trackIds")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 50:
        error(400, "invalid_input", "需要 1–50 个歌曲 ID")
    ids = [ncm_id({"id": ident}) for ident in ids]
    selected = data.get("selected")
    if type(selected) is not bool:
        error(400, "invalid_input", "selected 须为布尔值")
    if selected:
        save_tracks(ids)
        cm_db.playlist_add_tracks(playlist["id"], ids)
    else:
        cm_db.playlist_del_tracks(playlist["id"], ids)
    return {"ok": True}


def recent(_provider, data, uid, _ip):
    offset, limit = paging(data)
    ids = cm_db.recent_plays(uid, offset + limit + 1)
    tracks = cm_db.song_rows_to_meta(cm_db.songs_by_ids(ids[offset:offset + limit]))
    return page(resources(tracks), offset, len(ids) > offset + limit)


def history_record(_provider, data, uid, _ip):
    ident = ncm_id(data)
    if "playId" in data:
        play_id = ncm_id(data, "playId")
        elapsed = integer(data, "elapsedMs", 0, 4 * 3600 * 1000)
        cm_db.update_play_total(uid, ident, play_id, elapsed)
        return {"ok": True, "playId": str(play_id)}
    # Resolve server-side metadata before storing it in the existing library.
    if not cm_db.songs_by_ids([ident]):
        save_tracks([ident])
    return {"ok": True, "playId": str(cm_db.record_play(uid, ident))}


def roaming_songs(_provider, data, uid, ip):
    cookie = binding(uid)
    limit = integer(data, "limit", 1, 30, 20)
    reply = cm_ncm.call("/personal_fm", cookie=cookie, real_ip=ip)
    return page(resources([cm_ncm._norm_song(row) for row in (reply.get("data") or [])[:limit]]))


def cloud(_provider, data, uid, ip):
    offset, limit = paging(data)
    result = cm_ncm.call("/user/cloud", {"offset": offset, "limit": limit},
                         cookie=binding(uid), real_ip=ip)
    tracks = [cm_ncm._norm_song(row["simpleSong"]) for row in result.get("data", []) if row.get("simpleSong")]
    return page(resources(tracks), offset, result.get("hasMore", False))


BOTH = ("netease", "qqmusic")
OPERATIONS = {
    "catalog.search": Operation("搜索", search, providers=BOTH),
    "catalog.track": Operation("歌曲详情", details("song"), providers=BOTH),
    "catalog.album": Operation("专辑", details("album"), providers=BOTH),
    "catalog.artist": Operation("歌手", details("artist"), providers=BOTH),
    "catalog.playlist": Operation("公开歌单", details("playlist"), providers=BOTH),
    "discover.hot": Operation("热搜", hot),
    "discover.suggest": Operation("搜索联想", suggest),
    "discover.charts": Operation("榜单", charts),
    "discover.recommendations": Operation("每日推荐", recommendation, "music.library.read"),
    "track.lyrics": Operation("歌词", lyrics, providers=BOTH, media="lyrics"),
    "track.comments": Operation("歌曲评论", comments),
    "track.comment.add": Operation("发表评论", comment_add, "music.comment.write", write=True),
    "playback.qualities": Operation("音质档位", qualities, "music.play", media="playback"),
    "playback.resolve": Operation("播放取址", play, "music.play", media="playback"),
    "playback.mv": Operation("MV 取址", mv, "music.play", media="mv"),
    "playback.download": Operation("下载取址", download, "music.download", media="download"),
    "library.favorites": Operation("收藏", favorites, "music.library.read"),
    "library.favorite.set": Operation("修改收藏", favorite_set, "music.library.write", write=True),
    "library.playlists": Operation("个人歌单", user_playlists, "music.library.read"),
    "library.playlist": Operation("个人歌单详情", user_playlist, "music.library.read"),
    "library.playlist.create": Operation("新建歌单", playlist_create, "music.library.write", write=True),
    "library.playlist.edit": Operation("编辑歌单", playlist_edit, "music.library.write", write=True),
    "library.playlist.delete": Operation("删除歌单", playlist_delete, "music.library.write", write=True),
    "library.playlist.tracks": Operation("修改歌单曲目", playlist_tracks, "music.library.write", write=True),
    "library.cloud": Operation("云盘曲库", cloud, "music.cloud.read", media="cloud"),
    "history.recent": Operation("最近播放", recent, "music.history.read"),
    "history.record": Operation("记录播放进度", history_record, "music.history.write", write=True),
    "roaming.songs": Operation("私人漫游", roaming_songs, "music.library.read"),
}


def principal(header, scope):
    if not header.startswith("Bearer ") or not header[7:].startswith("cs_at_"):
        error(401, "authorization_required", "需要音乐服务访问令牌")
    grant = cm_db.passport_grant_by_access(cm_passport.hash_token(header[7:].strip()))
    if not grant or grant["access_expires"] <= cm_passport.now():
        error(401, "invalid_token", "音乐服务授权已失效")
    client = cm_db.passport_app_get(grant["app_key"])
    if not client or client["disabled"] or not grant["uid"]:
        error(403, "insufficient_scope", "该授权不能访问个人音乐服务")
    user = cm_db.get_user(grant["uid"])
    if (not user or user.get("disabled") or not cm_passport.has_scope(grant["scope"], scope)
            or not cm_passport.has_scope(client["scopes"], scope)):
        error(403, "insufficient_scope", "缺少这项音乐权限")
    return grant["uid"]


def dispatch(operation, body, header, ip):
    entry = OPERATIONS.get(operation)
    provider = body.get("provider") if isinstance(body, dict) else None
    data = body.get("input", {}) if isinstance(body, dict) else None
    if not isinstance(data, dict) or not isinstance(provider, str):
        error(400, "invalid_input", "需要 provider 和 input 对象")
    if not entry or provider not in entry.providers or not media_enabled(entry.media):
        error(404, "unsupported_operation", "该服务或平台未开放此能力")
    if provider == "qqmusic" and not cm_qq.BASE:
        error(404, "unsupported_operation", "该服务未启用 QQ 曲库")
    uid = principal(header, entry.scope) if entry.scope else 0
    if entry.write and body.get("confirm") is not True:
        error(400, "confirmation_required", "需要确认本次写入")
    try:
        return entry.run(provider, data, uid, ip)
    except cm_qq.Error as exc:
        error(exc.status, "upstream_error", exc.body["error"])
    except cm_ncm.NcmError as exc:
        if exc.status_code in (401, 403):
            error(403, "upstream_denied", "平台拒绝本次请求，请检查账号或曲目权限")
        error(502, "upstream_error", "音乐平台暂时不可用")
