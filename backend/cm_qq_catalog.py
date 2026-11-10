"""QQ music catalog adapters for the CurrentMusic engine response shapes."""
from base64 import b64decode
import binascii
from datetime import date
import re
from urllib.parse import urlsplit

import cm_lddc
from cm_ncm import _aux_for, _parse_lrc, _synth_words

ID = re.compile(r"[A-Za-z0-9]{1,64}")
TYPES = {"song": "songs", "artist": "artists", "album": "albums", "playlist": "playlists"}
DEFAULT_LIMITS = {"artist": 6, "album": 6, "playlist": 12}
QUALITIES = {"standard": "128", "exhigh": "320", "lossless": "flac"}
LEVELS = {value: key for key, value in QUALITIES.items()}


def _object(value):
    return value if isinstance(value, dict) else {}


def _rows(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _number(value):
    if type(value) is int:
        return value
    if isinstance(value, str) and len(value) <= 18 and value.isascii() and value.isdigit():
        return int(value)
    return 0


def _text(value):
    return value if isinstance(value, str) else ""


def _ident(value):
    value = str(value) if isinstance(value, int) else _text(value)
    return value if ID.fullmatch(value) else ""


def _art(mid, singer=False):
    if not mid:
        return ""
    prefix = "T001R300x300M000" if singer else "T002R300x300M000"
    return f"https://y.gtimg.cn/music/photo_new/{prefix}{mid}.jpg"


def _date(value):
    try:
        return (date.fromisoformat(value) - date(1970, 1, 1)).days * 86400000
    except (TypeError, ValueError):
        return 0


def _song(row):
    row = _object(row.get("songInfo") or row.get("musicData") or row)
    mid = _ident(row.get("mid") or row.get("songmid"))
    singers = _rows(row.get("singer"))
    album = _object(row.get("album"))
    album_mid = _ident(album.get("mid") or row.get("albummid"))
    mv = row.get("mv")
    if isinstance(mv, dict):
        mv = mv.get("vid") or mv.get("id")
    return {
        "id": mid, "provider": "qqmusic", "qq_mid": mid,
        "qq_id": _ident(row.get("id") or row.get("songid")),
        "name": _text(row.get("name") or row.get("title") or row.get("songname")),
        "artists": " / ".join(_text(s.get("name") or s.get("title")) for s in singers),
        "artist_ids": [mid for s in singers if (mid := _ident(s.get("mid")))],
        "album": _text(album.get("name") or album.get("title") or row.get("albumname")),
        "pic": _art(album_mid), "duration": _number(row.get("interval")) * 1000,
        "fee": int(bool(_number(_object(row.get("pay")).get("pay_play")))),
        "pop": 0, "mv": _ident(mv or row.get("vid")) or 0,
    }


def _songs(rows):
    return [song for row in _rows(rows) if (song := _song(row))["id"]]


def _artist(row):
    mid = _ident(row.get("mid") or row.get("singerMID"))
    return {"id": mid, "name": _text(row.get("name") or row.get("singerName")),
            "pic": _text(row.get("pic") or row.get("singerPic")) or _art(mid, singer=True),
            "alias": _text(row.get("alias") or row.get("subtitle") or row.get("foreignName"))}


def _album(row):
    mid = _ident(row.get("albummid") or row.get("albumMid") or row.get("mid"))
    singers = row.get("singer") or row.get("singers")
    artist = " / ".join(_text(s.get("name") or s.get("title")) for s in _rows(singers))
    return {"id": mid, "name": _text(row.get("name") or row.get("albumName") or row.get("title")),
            "pic": _text(row.get("pic") or row.get("albumPic")) or _art(mid),
            "artist": artist or _text(singers) or _text(row.get("singername"))}


def _playlist(row):
    return {"id": _ident(row.get("disstid") or row.get("dissid")),
            "name": _text(row.get("dissname")), "pic": _text(row.get("logo")),
            "trackCount": _number(row.get("songnum") or row.get("total_song_num")),
            "playCount": _number(row.get("listennum") or row.get("visitnum")),
            "creator": _text(row.get("nickname") or row.get("nick"))}


NORMALIZE = {"song": _song, "artist": _artist, "album": _album, "playlist": _playlist}


def _get_id(query, key, error):
    mid = _ident(query.get(key))
    if not mid:
        raise error(400, f"{key} 必须为 QQ 音乐 ID")
    return mid


def _paging(query, key, default, lo, hi, error):
    try:
        return max(lo, min(hi, int(query.get(key) or default)))
    except (ValueError, TypeError):
        raise error(400, f"{key} 必须为整数") from None


def _checked(call, error, path, query=None, session=None, *, body=None, allow_missing=False):
    status, result, _ = call("POST" if body is not None else "GET", path, query, body, session)
    if status == 404 and allow_missing:
        return {}
    if status in (400, 401, 403, 404, 409, 422, 429):
        raise error(status, "QQ 音乐拒绝该请求")
    if status != 200 or result.get("code", 200) not in (0, 200):
        raise error(502, "QQ 音乐上游响应异常")
    return result


def _legacy(call, error, path, query, session=None):
    result = _checked(call, error, path, query, session).get("response")
    if not isinstance(result, dict):
        raise error(502, "QQ 音乐上游响应格式错误")
    if result.get("code") != 0:
        if path == "/getSongListDetail" and result.get("code") == 10:
            raise error(403 if session else 401, "当前 QQ 会话无法读取该歌单")
        raise error(502, "QQ 音乐上游拒绝该请求")
    return result


def _search(query, session, call, error):
    keyword = (query.get("keywords") or "").strip()
    if not keyword or len(keyword.encode("utf-16-le")) // 2 > 60:
        raise error(400, "keywords 须为 1–60 个字符")
    selected = list(dict.fromkeys(t.strip() for t in (query.get("type") or query.get("types") or "").split(",") if t.strip()))
    if any(t not in TYPES for t in selected):
        raise error(400, "QQ 音乐搜索仅支持 song、artist、album、playlist")
    limit = _paging(query, "limit", 30, 1, 50, error)
    offset = _paging(query, "offset", 0, 0, 1000, error)
    out = {"totals": {}, "hasMore": {}}
    for kind in selected or TYPES:
        count = limit if selected else DEFAULT_LIMITS.get(kind, limit)
        page, skip = divmod(offset, 20)
        rows, total, more = [], 0, False
        for upstream_page in range(page + 1, page + (skip + count + 19) // 20 + 1):
            data = _checked(call, error, "/search", dict(keyword=keyword, type="singer" if kind == "artist" else kind,
                                                        limit=20, page=upstream_page), session)
            items = data.get("items")
            if not isinstance(items, list):
                raise error(502, "QQ 音乐搜索响应格式错误")
            total, more = _number(data.get("total")), bool(data.get("more"))
            rows.extend(items[skip:])
            skip = 0
            if not more or not items:
                break
        out[TYPES[kind]] = [item for row in _rows(rows[:count])
                            if (item := NORMALIZE[kind](row))["id"]]
        out["totals"][kind] = total
        out["hasMore"][kind] = len(rows) > count or (bool(rows) and more)
    return out


def _details(query, call, error):
    mids = [mid.strip() for mid in (query.get("ids") or "").split(",")]
    if len(mids) > 100 or not all(ID.fullmatch(mid) for mid in mids):
        raise error(400, "ids 须为 1–100 个逗号分隔的 QQ song MID")
    songs = []
    for i in range(0, len(mids), 20):
        batch = mids[i:i + 20]
        data = _checked(call, error, "/song/batch", body={"songs": [{"mid": mid} for mid in batch]}, allow_missing=True)
        if not data:
            continue
        results = _rows(data.get("results"))
        indexed = {row["index"]: row for row in results if type(row.get("index")) is int}
        if len(results) != len(batch) or indexed.keys() != set(range(len(batch))):
            raise error(502, "QQ 音乐歌曲详情响应不匹配")
        for index, mid in enumerate(batch):
            row = indexed[index]
            code = row.get("code")
            if code == 200:
                track = _song(_object(row.get("song")))
                if track["id"] != mid:
                    raise error(502, "QQ 音乐歌曲详情响应不匹配")
                songs.append(track)
            elif code != 404:
                raise error(502, "QQ 音乐歌曲详情上游请求失败")
    return {"songs": songs}


def _lyric(query, call, error):
    mid = _get_id(query, "id", error)
    data = _legacy(call, error, "/getLyric", {"songmid": mid, "trans": 1})
    main = _parse_lrc(_text(data.get("lyric")))
    translation = _text(data.get("trans"))
    if translation and not translation.lstrip().startswith("["):
        try:
            translation = b64decode(translation, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeError):
            translation = ""
    trans = _aux_for(main, None, _parse_lrc(translation))
    lines = []
    for i, (start, text) in enumerate(main):
        end = main[i + 1][0] if i + 1 < len(main) else start + 5000
        row = {"t": start, "txt": text, "trans": trans.get(i, ""), "roma": ""}
        if words := _synth_words(text, start, end):
            row.update(w=words, wSynth=True)
        lines.append(row)
    cm_lddc.ensure_words(lines)
    lines = cm_lddc.finalize_lines(cm_lddc.merge_bilingual(lines))
    return {"lines": lines, "source": "qqmusic:lrc" if lines else "none", "isYrc": False, "wordLevel": False}


def _album_detail(query, call, error):
    mid = _get_id(query, "id", error)
    data = _object(_legacy(call, error, "/getAlbumInfo", {"albummid": mid}).get("data"))
    if not data:
        raise error(404, "QQ 音乐专辑不存在")
    out = _album(data)
    out.update(id=mid, publishTime=_date(data.get("aDate")), company=_text(data.get("company")),
               description=_text(data.get("desc")), size=_number(data.get("total_song_num")),
               artist_ids=[singer] if (singer := _ident(data.get("singermid"))) else [],
               subType=_text(data.get("genre")), songs=_songs(data.get("list")))
    return out


def _artist_albums(mid, limit, offset, call, error):
    response = _legacy(call, error, "/getSingerAlbum", {"singermid": mid, "limit": limit, "page": offset})
    singer = _object(response.get("singer"))
    data = _object(singer.get("data"))
    if singer.get("code") != 0 or not isinstance(data.get("albumList"), list):
        raise error(502, "QQ 音乐歌手专辑响应格式错误")
    albums = []
    for row in _rows(data["albumList"]):
        out = _album(row)
        if not out["id"]:
            continue
        published = _text(row.get("publishDate") or row.get("publishTime") or row.get("publicTime"))
        timestamp = _date(published)
        out.update(size=_number(row.get("songNum") or row.get("totalNum")), type=_text(row.get("albumType")),
                   company=_text(row.get("company")), publishTime=timestamp,
                   year=int(published[:4]) if timestamp else 0)
        albums.append(out)
    total = _number(data.get("total") or data.get("totalNum"))
    return {"albums": albums, "total": total, "more": offset + len(albums) < total if total else len(albums) == limit}


def _artist_detail(query, call, error):
    mid = _get_id(query, "id", error)
    offset = _paging(query, "offset", 0, 0, 10000, error)
    limit = _paging(query, "limit", 100, 1, 200, error)
    info = _checked(call, error, "/singer/detail", {"mid": mid})
    out = _artist(_object(info.get("singer")) or info)
    albums = _artist_albums(mid, 30, 0, call, error)
    songs, total, more = [], 0, False
    for start in range(0, limit, 30):
        page = _checked(call, error, "/singer/songs", {"mid": mid, "offset": offset + start,
                        "limit": min(30, limit - start)}, allow_missing=True)
        if not page:
            more = False
            break
        songs.extend(_songs(page.get("songs")))
        total, more = _number(page.get("total")), bool(page.get("more"))
        if not more:
            break
    out.update(id=mid, total=total or len(songs), more=more, songs=songs,
               albums=albums["albums"], albumTotal=albums["total"], albumsMore=albums["more"])
    return out


def _playlist_detail(query, session, call, error):
    mid = _get_id(query, "id", error)
    rows = _rows(_legacy(call, error, "/getSongListDetail", {"disstid": mid}, session).get("cdlist"))
    if not rows:
        raise error(404, "QQ 音乐歌单不存在")
    row = rows[0]
    out = _playlist(row)
    out.update(id=mid, cover=out.pop("pic"), description=_text(row.get("desc")),
               songs=_songs(row.get("songlist"))[:100])
    out.pop("playCount")
    return out


def _play(query, session, call, error):
    mid = _get_id(query, "id", error)
    level = query.get("level") or "auto"
    quality = "best" if level == "auto" else QUALITIES.get(level)
    if not quality:
        raise error(422, "QQ 音乐不支持该档位", key="qq_quality_unsupported")
    try:
        max_br = int(query.get("maxBr") or query.get("maxbr") or 0)
    except ValueError:
        raise error(400, "maxBr 必须为整数") from None
    if level == "auto" and max_br > 0:
        if max_br < 128000:
            raise error(422, "码率上限低于兼容接口支持的最低档位", key="qq_quality_unsupported")
        quality = "320" if max_br >= 320000 else "128"
    for quality in ("320", "128") if level == "auto" and quality == "320" else (quality,):
        params = {"songmid": mid, "quality": quality}
        if query.get("mediaId"):
            params["mediaId"] = _get_id(query, "mediaId", error)
        response = _checked(call, error, "/getMusicPlay", params, session)
        row = _object(_object(_object(response.get("data")).get("playUrl")).get(mid))
        url = _text(row.get("url"))
        try:
            parsed = urlsplit(url)
        except ValueError:
            raise error(502, "QQ 音乐返回的播放链接无效") from None
        if url and not row.get("preview") and parsed.scheme in ("http", "https") and parsed.hostname and parsed.username is None:
            actual = _text(row.get("quality")) or quality
            if actual not in LEVELS:
                raise error(502, "QQ 音乐未返回实际播放档位")
            return {"url": url, "level": LEVELS[actual], "requestedLevel": level, "source": "qqmusic",
                    "quality": actual, "host": parsed.hostname, "hosts": [], "fromCache": False,
                    "switched": False, "br": 0, "size": 0, "sr": 0, "bits": 0, "ch": 0,
                    "type": "flac" if actual == "flac" else "mp3", "md5": ""}
    raise error(422, "当前 QQ 会话未取得完整播放链接", key="qq_playback_unavailable")


def read(path, query, session, call, error):
    if path == "/search":
        return _search(query, session, call, error)
    if path == "/song/detail":
        return _details(query, call, error)
    if path == "/lyric":
        return _lyric(query, call, error)
    if path == "/album":
        return _album_detail(query, call, error)
    if path == "/artist":
        return _artist_detail(query, call, error)
    if path == "/artist/albums":
        mid = _get_id(query, "id", error)
        return _artist_albums(mid, _paging(query, "limit", 30, 1, 60, error),
                              _paging(query, "offset", 0, 0, 10000, error), call, error)
    if path == "/playlist":
        return _playlist_detail(query, session, call, error)
    if path == "/song/url":
        return _play(query, session, call, error)
    raise error(404, "QQ 音乐接口不存在")
