"""NCM api-enhanced 本地代理层：走 127.0.0.1:3001，附 SVIP cookie（mtime 缓存，随每日刷新自动跟随）。

经验来自 astrbot 插件 NcmSvipClient：冷查询可达 4~11s 故超时 15s；
/song/url/v1 响应的 level 字段是「实际返回档」而非回显请求档。
"""
import json
import logging
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.error
import urllib.request

import cm_lddc

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CM_DATA_DIR", os.path.join(ROOT, "data"))
BASE = os.environ.get("CM_NCM_BASE", "http://127.0.0.1:3001")
COOKIE_PATH = os.environ.get("CM_NCM_COOKIE", os.path.join(DATA_DIR, "ncm-cookie"))

_cookie_lock = threading.Lock()
_cookie_cache = (0.0, "")

log = logging.getLogger("cm.ncm")

# 音频探测/音源上游的「墙钟」护栏：
# urllib 的 timeout 只约束 socket 操作，**DNS 解析不受它约束**。实测 CDN 域名
# 解析偶发卡住十几秒，probe_audio 的 2s timeout 形同虚设，整个首播跟着卡。
# 这里用守护线程 + Event 等一个真正的总时限；超时按「探测失败放行」处理。
_PROBE_GATE = threading.BoundedSemaphore(16)
_URL_CALL_GATE = threading.BoundedSemaphore(32)


def _run_with_wall_clock(fn, timeout, default=None, gate=None, name="cm-bounded"):
    """在守护线程里执行 fn，最多等 timeout 秒；超时/无空闲槽位返回 default。

    调用方必须能接受 default（探测类操作超时放行）。异常照常抛出。
    守护线程超时后不会阻塞进程退出；底层 socket 通常会在自己的 timeout 后结束。
    """
    if gate is not None and not gate.acquire(timeout=0.05):
        return default
    box = {}
    done = threading.Event()

    def work():
        try:
            box["v"] = fn()
        except BaseException as e:  # noqa: BLE001 原样回抛给调用线程
            box["e"] = e
        finally:
            done.set()
            if gate is not None:
                gate.release()

    threading.Thread(target=work, daemon=True, name=name).start()
    if not done.wait(timeout):
        return default
    if "e" in box:
        raise box["e"]
    return box["v"]


class NcmError(Exception):
    """可展示给客户端的网易云上游错误。

    ``status_code`` 仅用于项目专用入口把明确的业务拒绝（例如短信每日
    限额）映射为 4xx；网络故障和未知上游异常仍由网关统一返回 502。
    """

    def __init__(self, message, status_code=None, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response or {}


_WALL_TIMEOUT = object()


def _bounded_call(path, params, timeout, **kw):
    """带总时限的 NCM 调用（只用于首播关键路径）。"""
    try:
        out = _run_with_wall_clock(
            lambda: call(path, params, timeout=timeout, **kw),
            timeout + 0.5, default=_WALL_TIMEOUT,
            gate=_URL_CALL_GATE, name="cm-song-url")
    except NcmError:
        raise
    except Exception as e:  # noqa: BLE001
        raise NcmError(f"NCM 上游请求失败: {e}")
    if out is _WALL_TIMEOUT:
        raise NcmError(f"音源解析超时（上游 {timeout + 0.5:.1f}s 未响应），请稍后重试")
    return out


def _json_error_response(exc):
    try:
        raw = exc.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError, UnicodeError):
        pass
    return {}


def _json_error_message(exc):
    """从上游 HTTPError 的 JSON body 提取网易云的 message/msg。"""
    data = _json_error_response(exc)
    return data.get("message") or data.get("msg") or ""


def ncm_cookie():
    global _cookie_cache
    with _cookie_lock:
        try:
            mtime = os.path.getmtime(COOKIE_PATH)
        except OSError:
            return ""
        if _cookie_cache[0] != mtime:
            try:
                with open(COOKIE_PATH, "r", encoding="utf-8") as f:
                    _cookie_cache = (mtime, f.read().strip())
            except OSError:
                return ""
        return _cookie_cache[1]


def with_os_pc(ck):
    """cookie 补 `os=pc`。

    用户反馈：**不传 os 时，某些设备/账号会拿到异常码率（或杜比全景声空间音频变体）
    的播放地址**；带 `os=pc` 才稳定返回常规码率的 url。缺失时才追加，避免重复。
    """
    if not ck:
        return ck
    if re.search(r"(^|;\s*)os=", ck):
        return ck
    return ck.rstrip("; ") + "; os=pc"


def call(path, params=None, timeout=15.0, retries=1, with_cookie=True, cookie=None, real_ip=None, bypass_cache=False):
    """GET 请求 api-enhanced；默认带服务器 SVIP cookie，可显式换绑定的用户 cookie。

    real_ip：仅由服务端从可信请求头解析后传入（客户端参数里的 realIP 会被网关剥离），
    用于搜索、媒体地址与账号写操作，让上游按用户真实网络位置检索/选边缘/做风控。
    """
    q = dict(params or {})
    if real_ip:
        q["realIP"] = real_ip
    ck = with_os_pc(cookie if cookie is not None else (ncm_cookie() if with_cookie else ""))
    if ck:
        q["cookie"] = ck
    url = f"{BASE}{path}?{urllib.parse.urlencode(q)}"
    headers = {"User-Agent": "CurrentMusic/1.0"}
    if bypass_cache:
        headers["X-Apicache-Bypass"] = "1"
    last_err = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # api-enhanced 常以 HTTP 4xx/5xx 返回 JSON 业务错误；读取 body，
            # 否则上层只能看到无意义的 "HTTP Error 400"。
            message = _json_error_message(e)
            last_err = (e, message)
        except Exception as e:  # noqa: BLE001 统一重试后抛业务错误
            last_err = (e, "")
    exc, upstream_message = last_err
    status = getattr(exc, "code", None)
    msg = upstream_message or str(exc)
    if status == 503 or "503" in msg or "Service Unavailable" in msg:
        raise NcmError("网易云暂时拒绝了请求（多因风控或频繁操作），请稍后重试，或改用扫码方式绑定",
                       status_code=503)
    if status == 401 or "401" in msg:
        raise NcmError("网易云拒绝了该操作（登录信息可能已失效）", status_code=401)
    if upstream_message:
        raise NcmError(f"网易云请求失败：{upstream_message}", status_code=status if 400 <= (status or 0) < 500 else None)
    raise NcmError(f"NCM 上游请求失败: {msg}")


def post_json(path, payload, cookie=None, timeout=10.0, real_ip=None):
    """POST JSON 到 api-enhanced（少数接口如 /weblog 需要对象 body，而不是 query）。"""
    payload = dict(payload)
    if real_ip:
        payload["realIP"] = real_ip
    ck = with_os_pc(cookie if cookie is not None else ncm_cookie())
    if ck:
        payload["cookie"] = ck
    # 上游缓存键不包含 POST body。写操作必须绕过缓存，凭据留在请求体内。
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "CurrentMusic/1.0", "X-Apicache-Bypass": "1"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        response = _json_error_response(e)
        message = response.get("message") or response.get("msg")
        raise NcmError(f"网易云请求失败：{message or e}", status_code=e.code, response=response) from None
    except Exception as e:  # noqa: BLE001
        raise NcmError(f"NCM 上游请求失败: {e}")


def weblog(cookie, events, timeout=10.0, real_ip=None):
    """上报网易云客户端日志（听歌 startplay / play）。

    api-enhanced 的 /weblog 模块读取 body.data；NCM 原始接口为 /api/feedback/weblog。
    """
    return post_json("/weblog", {
        "data": {"logs": json.dumps(events, ensure_ascii=False)},
    }, cookie=cookie, timeout=timeout, real_ip=real_ip)


def scrobble(cookie, ncm_id, seconds, *, total=0, name="", artist="", real_ip=None):
    """通过桌面客户端 PLV/PLD 上报一次播放，旧上游缺少新版端点时回退。"""
    params = {
        "id": int(ncm_id),
        "time": int(seconds),
        "total": int(total) if total > 0 else int(seconds),
        "name": name,
        "artist": artist,
    }
    try:
        # 上游依次上传 PLV 与 PLD，每次超时 15 秒。
        result = post_json("/scrobble/v1", params, cookie=cookie, timeout=32.0, real_ip=real_ip)
    except NcmError as e:
        if e.status_code != 404:
            raise
        result = post_json("/scrobble", {"id": params["id"], "time": params["time"], "sourceid": "0"},
                           cookie=cookie, timeout=20.0, real_ip=real_ip)
        details = result.get("details") if isinstance(result, dict) else None
        play = details.get("play") if isinstance(details, dict) else None
        if isinstance(play, dict) and play.get("code") == 200:
            return
        raise NcmError("网易云旧版听歌打卡未确认 play") from None
    details = (result.get("details") or {}) if isinstance(result, dict) else {}
    if (isinstance(result, dict) and result.get("code") == 200 and isinstance(details, dict)
            and all(isinstance(details.get(key), dict) and details[key].get("fileName") for key in ("plv", "pld"))):
        return
    raise NcmError("网易云新版听歌打卡未确认 PLV/PLD",
                   status_code=result.get("code") if isinstance(result, dict) else None)


def call_multipart(path, params=None, field="file", filename="upload.bin",
                   content_type="application/octet-stream", data=b"",
                   timeout=30.0, cookie=None, real_ip=None):
    """multipart/form-data 上传到 api-enhanced（封面/头像/播客声音这类**文件**接口）。

    与 `call()` 的区别：文件走 body，其余参数仍走 query。cookie 语义一致
    （默认服务端 SVIP 档，可由调用方换成绑定用户的 cookie）。

    只给**白名单**路径用（见 cm_ncm_gateway.UPLOAD_FIELD）：登记表 + 分级 + 阶段门禁
    都在 cm_server 侧完成，本函数自身不做业务判断。
    """
    q = dict(params or {})
    if real_ip:
        q["realIP"] = real_ip
    ck = with_os_pc(cookie if cookie is not None else ncm_cookie())
    if ck:
        q["cookie"] = ck
    url = f"{BASE}{path}?{urllib.parse.urlencode(q)}"

    boundary = "----CurrentMusicUpload" + os.urandom(12).hex()
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = head + data + tail

    req = urllib.request.Request(url, data=body, method="POST", headers={
        "User-Agent": "CurrentMusic/1.0",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body)),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 与 call() 同口径归一
        msg = str(e)
        if "503" in msg or "Service Unavailable" in msg:
            raise NcmError("网易云暂时拒绝了请求（多因风控或频繁操作），请稍后重试")
        if "401" in msg:
            raise NcmError("网易云拒绝了该操作（登录信息可能已失效）")
        raise NcmError(f"NCM 上游上传失败: {msg}")


# ---------- 响应归一化 ----------

def _https(url):
    """NCM CDN 已支持 HTTPS（实测音频/封面均 206/200），统一升级消除混合内容。"""
    if isinstance(url, str) and url.startswith("http://"):
        return "https://" + url[7:]
    return url


def _norm_song(s, pop=None):
    # 歌手数组：云搜索/详情用 ar，部分老接口用 artists——统一取，供前端「点歌手进主页」
    _ar = s.get("ar") or s.get("artists") or []
    return {
        "ncm_id": s.get("id"),
        "name": s.get("name") or "",
        "artists": " / ".join(a.get("name", "") for a in _ar),
        "artist_ids": [a.get("id") for a in _ar if a.get("id")],
        "album": (s.get("al") or {}).get("name") or "",
        "pic": _https((s.get("al") or {}).get("picUrl") or ""),
        "duration": s.get("dt") or 0,
        "fee": s.get("fee") if s.get("fee") is not None else 0,
        "pop": pop if pop is not None else s.get("pop") or 0,
        # MV id（0 = 无 MV）：歌曲条右侧的「播放 MV」按钮据此显示/隐藏
        "mv": s.get("mv") or s.get("mvid") or 0,
    }


def search(keywords, limit=30, offset=0, real_ip=None):
    d = call("/cloudsearch", {"keywords": keywords, "limit": limit, "offset": offset, "type": 1}, real_ip=real_ip)
    songs = (((d or {}).get("result") or {}).get("songs")) or []
    return [_norm_song(s) for s in songs]


# ---------- 分区搜索 ----------

# 搜索类型 → (上游 cloudsearch 的 type, 结果数组字段, 总数计数字段)
_SEARCH_TYPES = {
    "song":     (1,    "songs",     "songCount"),
    "artist":   (100,  "artists",   "artistCount"),
    "album":    (10,   "albums",    "albumCount"),
    "playlist": (1000, "playlists", "playlistCount"),
    "lyric":    (1006, "songs",     "songCount"),
}
_SEARCH_ALL = ("song", "artist", "album", "playlist")


def _norm_artist(a):
    return {
        "id": a.get("id"), "name": a.get("name") or "",
        "pic": _https(a.get("picUrl") or a.get("img1v1Url") or ""),
        "alias": " / ".join((a.get("alias") or [])[:2]),
    }


def _norm_album(a):
    return {
        "id": a.get("id"), "name": a.get("name") or "",
        "pic": _https(a.get("picUrl") or ""),
        "artist": " / ".join(ar.get("name", "") for ar in (a.get("artists") or [])),
    }


def _norm_playlist(p):
    return {
        "id": p.get("id"), "name": p.get("name") or "",
        "pic": _https(p.get("coverImgUrl") or ""),
        "trackCount": p.get("trackCount") or 0,
        "playCount": p.get("playCount") or 0,
        "creator": ((p.get("creator") or {}).get("nickname")) or "",
    }


_NORMALIZERS = {"song": _norm_song, "lyric": _norm_song, "artist": _norm_artist,
                "album": _norm_album, "playlist": _norm_playlist}


def search_types(keywords, types=_SEARCH_ALL, limit=10, offset=0, real_ip=None):
    """按需搜索指定类型（并行请求上游），返回结果 + 各类型总数 + 是否还有下一页。

    **为什么要「按需」**：实测上游各类型耗时差异极大——
    歌手 6.1s、专辑 4.2s、单曲 3.0s、歌单 2.1s。四类并行时整体被**最慢的那个**
    拖住（实测端到端 6.2~9.1s），而搜索页默认展示的是「单曲」，没有理由让首屏
    去等「歌手」。拆成按类型请求后，首屏只需等单曲（~3s），其余类型交给前端
    后台补齐，或切到对应 TAB 时再取。

    offset/limit 供「显示更多」分页；*Count 用于判断是否还有下一页，
    上游偶尔不返回总数时退化为「本页是否满页」。
    """
    from concurrent.futures import ThreadPoolExecutor
    tsel = [t for t in types if t in _SEARCH_TYPES] or ["song"]
    if "lyric" in tsel and len(tsel) != 1:
        raise ValueError("歌词搜索请单独指定 type=lyric")
    with ThreadPoolExecutor(max_workers=len(tsel)) as ex:
        futs = {t: ex.submit(call, "/cloudsearch", {
            "keywords": keywords, "limit": limit, "offset": offset,
            "type": _SEARCH_TYPES[t][0]}, real_ip=real_ip) for t in tsel}
        raws = {t: (f.result() or {}) for t, f in futs.items()}

    out, totals, has_more = {}, {}, {}
    for t in tsel:
        _tid, arr_key, cnt_key = _SEARCH_TYPES[t]
        r = (raws.get(t) or {}).get("result") or {}
        items = r.get(arr_key) or []
        total = int(r.get(cnt_key) or 0)
        out[arr_key] = [_NORMALIZERS[t](x) for x in items]
        if t == "lyric":
            import cm_search_lyrics
            out[arr_key] = cm_search_lyrics.enrich(items, out[arr_key], keywords)
        count_key = "song" if t == "lyric" else t
        totals[count_key] = total
        has_more[count_key] = (offset + len(items) < total) if total else (len(items) >= limit)
    out["totals"] = totals
    out["hasMore"] = has_more
    return out


def search_multi(keywords, song_limit=30, aux_limit=6, real_ip=None):
    """一次取回全部类型（歌手/专辑/歌单用较小的 aux 条数）。

    供不关心分页的调用方使用；搜索页改用 search_types 按需取。
    行为与历史一致，仅把归一化抽成了公共函数。
    """
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_song = ex.submit(call, "/cloudsearch",
                           {"keywords": keywords, "limit": song_limit, "offset": 0, "type": 1}, real_ip=real_ip)
        f_art = ex.submit(call, "/cloudsearch",
                          {"keywords": keywords, "limit": aux_limit, "offset": 0, "type": 100}, real_ip=real_ip)
        f_alb = ex.submit(call, "/cloudsearch",
                          {"keywords": keywords, "limit": aux_limit, "offset": 0, "type": 10}, real_ip=real_ip)
        f_pl = ex.submit(call, "/cloudsearch",
                         {"keywords": keywords, "limit": 12, "offset": 0, "type": 1000}, real_ip=real_ip)
        d_song, d_art, d_alb, d_pl = f_song.result(), f_art.result(), f_alb.result(), f_pl.result()
    return {
        "songs": [_norm_song(s) for s in
                  (((d_song or {}).get("result") or {}).get("songs") or [])],
        "artists": [_norm_artist(a) for a in
                    (((d_art or {}).get("result") or {}).get("artists") or [])],
        "albums": [_norm_album(a) for a in
                   (((d_alb or {}).get("result") or {}).get("albums") or [])],
        "playlists": [_norm_playlist(p) for p in
                      (((d_pl or {}).get("result") or {}).get("playlists") or [])],
    }


def album_songs(album_id):
    """专辑全曲 + 专辑元数据（/album 的歌曲是 ar/al 形态，_norm_song 已兼容）。

    元数据（发行时间/公司/简介/曲目数）上游本来就在同一响应里返回，一并透出，
    免得前端为了画专辑页再去调别的接口。"""
    d = call("/album", {"id": int(album_id)})
    al = (d or {}).get("album") or {}
    songs = [_norm_song(s) for s in ((d or {}).get("songs") or [])]
    artists = [(ar.get("name") or "") for ar in (al.get("artists") or [])]
    return {"id": al.get("id") or int(album_id), "name": al.get("name") or "",
            "pic": _https(al.get("picUrl") or ""), "artist": " / ".join(artists),
            "artist_ids": [ar.get("id") for ar in (al.get("artists") or []) if ar.get("id")],
            "publishTime": al.get("publishTime") or 0,
            "company": al.get("company") or "",
            "description": al.get("description") or "",
            "size": al.get("size") or len(songs),
            "subType": al.get("subType") or "",
            "songs": songs}


def artist_sub(cookie, artist_id, on=True, real_ip=None):
    """关注/取关歌手——写用户自己的网易云账号（需绑定 cookie）。"""
    d = call("/artist/sub", {"id": int(artist_id), "t": 1 if on else 0},
             cookie=cookie, timeout=15.0, real_ip=real_ip)
    code = (d or {}).get("code")
    if code != 200:
        msg = (d or {}).get("message") or (d or {}).get("msg") or f"错误码 {code}"
        raise NcmError(f"{'关注' if on else '取消关注'}歌手失败：{msg}")
    return True


def artist_sublist(cookie, limit=100, offset=0):
    """已关注歌手列表（网易云 /artist/sublist，条目在 data 字段）。"""
    d = call("/artist/sublist", {"limit": limit, "offset": offset}, cookie=cookie, timeout=20.0)
    code = (d or {}).get("code")
    items = (d or {}).get("data") or (d or {}).get("artist") or []
    if code != 200 and not items:
        msg = (d or {}).get("message") or (d or {}).get("msg") or f"错误码 {code}"
        raise NcmError(f"获取关注歌手失败：{msg}")
    return {
        "artists": [{
            "artist_id": a.get("id"), "name": a.get("name") or "",
            "pic": _https(a.get("picUrl") or a.get("img1v1Url") or ""),
            "alias": " / ".join((a.get("alias") or [])[:2]),
        } for a in items],
        "hasMore": bool((d or {}).get("hasMore")),
        "count": int((d or {}).get("count") or len(items)),
    }


def artist_albums(artist_id, limit=30, offset=0):
    """歌手专辑（/artist/album 的 hotAlbums：按热度排序，含发行时间/曲目数/类型）。"""
    d = call("/artist/album", {"id": int(artist_id), "limit": int(limit), "offset": int(offset)})
    items = (d or {}).get("hotAlbums") or []
    out = []
    for a in items:
        if not a or not a.get("id"):
            continue
        ts = int(a.get("publishTime") or 0)
        out.append({
            "id": int(a["id"]),
            "name": a.get("name") or "",
            "pic": _https(a.get("picUrl") or a.get("blurPicUrl") or ""),
            "size": int(a.get("size") or 0),                      # 曲目数
            "type": a.get("subType") or a.get("type") or "",      # 录音室版/现场版/Single…
            "company": a.get("company") or "",
            "year": time.localtime(ts // 1000).tm_year if ts else 0,
            "publishTime": ts,
        })
    info = (d or {}).get("artist") or {}
    total = int(info.get("albumSize") or 0)
    return {"albums": out, "total": total, "more": bool((d or {}).get("more"))}


def artist_works(artist_id, limit=100, offset=0, albums=30):
    """歌手页：资料（/artists）+ 全部作品（/artist/songs 分页）+ 专辑（/artist/album），三者并行。"""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_info = ex.submit(call, "/artists", {"id": int(artist_id)})
        f_songs = ex.submit(call, "/artist/songs",
                            {"id": int(artist_id), "limit": limit, "offset": offset,
                             "order": "hot"})
        f_albums = ex.submit(artist_albums, artist_id, albums, 0) if albums else None
        d_info, d_songs = f_info.result(), f_songs.result()
        alb = f_albums.result() if f_albums else {"albums": [], "total": 0, "more": False}
    a = (d_info or {}).get("artist") or {}
    return {
        "id": a.get("id") or int(artist_id), "name": a.get("name") or "",
        "pic": _https(a.get("picUrl") or a.get("img1v1Url") or ""),
        "alias": " / ".join((a.get("alias") or [])[:2]),
        "total": (d_songs or {}).get("total") or len((d_songs or {}).get("songs") or []),
        "more": bool((d_songs or {}).get("more")),
        "songs": [_norm_song(s) for s in ((d_songs or {}).get("songs") or [])],
        # 专辑数取资料里的 albumSize（比首屏返回的条数准）；首屏只给前 N 张，其余走 /ncm/artist/albums
        "albumTotal": int(a.get("albumSize") or alb.get("total") or len(alb["albums"])),
        "albums": alb["albums"],
        "albumsMore": bool(alb.get("more")) or int(a.get("albumSize") or 0) > len(alb["albums"]),
    }


def song_detail(ids):
    if isinstance(ids, (int, str)):
        ids = [ids]
    d = call("/song/detail", {"ids": ",".join(str(int(i)) for i in ids)})
    songs = (d or {}).get("songs") or []
    return [_norm_song(s, pop=s.get("pop") or 0) for s in songs]


# 音频文件魔数（用于识别"地址有效但返回的是 HTML 错误页"的情况）
_AUDIO_MAGIC = (b"fLaC", b"ID3", b"OggS", b"RIFF", b"ftyp", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa")


def _flac_streaminfo(buf):
    """从 FLAC 头解析 STREAMINFO → (采样率, 位深, 声道数)。解析不出返回 (0,0,0)。

    仅当响应以 fLaC 开头时可用；STREAMINFO 固定紧随其后（块头 4 字节 + 34 字节数据）。
    """
    try:
        if not buf.startswith(b"fLaC"):
            return (0, 0, 0)
        i = 4
        # 跳过元数据块头，找到 STREAMINFO（type 0）
        while i + 4 <= len(buf):
            hdr = buf[i]
            btype = hdr & 0x7F
            blen = int.from_bytes(buf[i + 1:i + 4], "big")
            if btype == 0:
                si = buf[i + 4:i + 4 + blen]
                if len(si) < 18:
                    return (0, 0, 0)
                x = int.from_bytes(si[10:18], "big")
                sr = x >> 44
                ch = ((x >> 41) & 0x07) + 1
                bits = ((x >> 36) & 0x1F) + 1
                return (sr, bits, ch)
            i += 4 + blen
            if hdr & 0x80:      # 最后一个块
                break
    except Exception:  # noqa: BLE001
        pass
    return (0, 0, 0)


def probe_audio(url, timeout=1.5, strict=False):
    """探测播放地址，返回 (是否音频, {sr,bits,ch})。

    踩过的坑：接口层面"有 url"并不代表真的能播——上游可能返回 HTML 错误页
    （实测某档位在部分歌曲上 403 并回 HTML）。这里取前 2KB 校验魔数，
    校验不过就当作该档不可用，让上层阶梯自动降档；同时解析 FLAC 头拿到
    采样率/位深/声道，供客户端提示"高解析度"档位（192kHz/多声道）。
    探测本身失败（超时/连接抖动）时**放行**——不能因为一次探测把正常播放拦掉。

    timeout 默认 1.5s：2KB 头通常 <0.3s 就回；外层再有墙钟护栏，DNS 卡住
    也不会把首播拖成十几秒。探测超时按放行处理，不改变可用性。
    strict 时用于第三方匹配音源：超时/网络错误也不能视为已验证的音频。
    """
    t0 = time.time()
    fetch = (lambda: _probe_audio_once(url, timeout, strict=True)) if strict else (lambda: _probe_audio_once(url, timeout))
    out = _run_with_wall_clock(fetch,
                               timeout + 0.3, default=None,
                               gate=_PROBE_GATE, name="cm-audio-probe")
    if out is None:
        if strict:
            return (False, {})
        log.warning("音频头探测超时或繁忙 host=%s 已等待 %.1fs（放行）",
                    urllib.parse.urlsplit(url).hostname or "?",
                    time.time() - t0)
        return (True, {})
    return out


def _probe_audio_once(url, timeout, strict=False):
    total = 0
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "CurrentMusic/1.0",
            "Range": "bytes=0-2047",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            head = resp.read(16)
            tail = resp.read(2032)
            if strict:
                match = re.search(r"/(\d+)$", resp.headers.get("Content-Range", ""))
                if match:
                    total = int(match[1])
                elif resp.status == 200:
                    total = int(resp.headers.get("Content-Length", "0"))
    except urllib.error.HTTPError:
        # 明确的服务端拒绝（403/404/410…）= 该地址确实不可用 → 判否
        return (False, {})
    except Exception:  # noqa: BLE001
        return (not strict, {})
    buf = head + tail
    ok = any(head.startswith(m) for m in _AUDIO_MAGIC) or head[4:8] == b"ftyp"
    info = {}
    if buf.startswith(b"fLaC"):
        sr, bits, ch = _flac_streaminfo(buf)
        if sr:
            info = {"sr": sr, "bits": bits, "ch": ch}
    if strict and ok:
        kind = "flac" if head.startswith(b"fLaC") else "wav" if head.startswith(b"RIFF") else "ogg" if head.startswith(b"OggS") else "m4a" if b"ftyp" in head[:8] else "mp3"
        info.update(type=kind, size=total)
    return (ok, info)


def song_url(ncm_id, level="lossless", immerse=None, real_ip=None, probe=True, timing=None):
    """取某档位的播放地址。

    ``probe=False`` 跳过 2KB 音频头校验（也不返回 sr/bits/ch）：档位择优时先用它
    并行拿各档的地址与元信息，最后**只对胜出的那一档**做一次校验（见 cm_stream 的
    「档位策略」注释）。校验是「这个地址真能播」的唯一保证——上游确实会在部分歌曲的
    部分档位上返回 HTML 错误页，所以**最终下发给客户端的地址必须校验过**。
    """
    # immerse：仅 level=sky 时生效（API 文档）——c51=5.1 声道（默认）/ ste=环绕立体声类型
    q = {"id": int(ncm_id), "level": level}
    if immerse and level == "sky":
        q["immerseType"] = "ste" if immerse == "ste" else "c51"
    # realIP：把**真实用户 IP** 告诉上游，它据此挑离用户近的 CDN 边缘节点。
    # 泛化转发（cm_server._ncm_forward）早就注入了这个参数，但播放主路径
    # /ncm/song/url 走的是专用分支，以前**没传**——等于让上游按源站所在地
    # （洛杉矶）来选节点，国内用户可能被分到海外边缘，高峰期表现为播放卡顿。
    if real_ip:
        q["realIP"] = real_ip
    # 音源地址是首播关键路径：本地 NCM API 正常 <1s，默认 15s×2 次会把一次上游
    # 卡顿放大成 30s。这里单次 4s，外层再有 4.5s 墙钟护栏（防止上游慢速吐字节），
    # 超时交给上层降档/重试，不阻塞客户端。
    t_up = time.time()
    d = _bounded_call("/song/url/v1", q, 4.0, retries=0)
    if timing is not None:
        timing["upstreamMs"] = int((time.time() - t_up) * 1000)
    items = (d or {}).get("data") or []
    if not items:
        raise NcmError("未取得播放地址")
    it = items[0]
    if not it.get("url"):
        raise NcmError("该歌曲不可播放（版权/地区限制）")
    if it.get("freeTrialInfo"):
        raise NcmError("官方接口仅返回试听片段，需尝试备用音源")
    url = _https(it["url"])
    spec = {}
    if probe:
        t_probe = time.time()
        ok, spec = probe_audio(url)
        if timing is not None:
            timing["probeMs"] = int((time.time() - t_probe) * 1000)
        if not ok:
            raise NcmError(f"{level} 档位地址不可用（上游返回了错误页），已尝试降档")
    out = {
        "url": url, "br": it.get("br") or 0, "type": it.get("type") or "",
        "size": it.get("size") or 0, "level": it.get("level") or level,
        "md5": it.get("md5") or "",
        # 真实规格（解析自文件头；非 FLAC 时为 0）——客户端据此提示高解析度档位
        "sr": spec.get("sr") or 0, "bits": spec.get("bits") or 0, "ch": spec.get("ch") or 0,
    }
    return out


def song_url_match(ncm_id, real_ip=None):
    """灰色曲目补充接口；只有实测收到音频文件头时才返回，不冒充请求的音质档位。"""
    # 上游默认缓存成功响应两分钟，网页链接也可能被缓存；失败重试/refresh 必须重新匹配。
    params = {"id": int(ncm_id), "timestamp": _ts()}
    source = os.environ.get("CM_NCM_MATCH_SOURCE", "").strip()
    if source:
        params["source"] = source
    data = _bounded_call("/song/url/match", params, 20.0, retries=0,
                         with_cookie=False, real_ip=real_ip)
    data = data if isinstance(data, dict) else {}
    url = data.get("proxyUrl") or data.get("data")
    try:
        parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        valid = parsed is not None and parsed.scheme in ("http", "https") and bool(parsed.hostname)
    except ValueError:
        valid = False
    if not valid:
        raise NcmError("灰色曲目匹配未返回音频地址，请稍后重试")
    info = data.get('matchInfo')
    info = info if isinstance(info, dict) else {}
    expected = info.get('expectedDurationMs') or 0
    duration = info.get('durationMs') or 0
    if (info.get('validated') is not True or info.get('validationVersion') != 1 or info.get('url') != url
            or type(expected) not in (int, float) or type(duration) not in (int, float)
            or not math.isfinite(expected) or not math.isfinite(duration) or expected <= 0 or duration <= 0
            or abs(duration - expected) > max(2000, min(10000, expected * .03))):
        raise NcmError("灰色曲目匹配未通过完整时长校验，请检查上游匹配器部署后重试")
    url = _https(url)
    ok, spec = probe_audio(url, timeout=2.5, strict=True)
    if not ok:
        raise NcmError("灰色曲目匹配未取得可验证的音频（错误页或网络不可用），请稍后重试")
    return {"url": url, "br": info.get('br') or 0, "type": info.get('type') or spec.get("type") or "", "size": info.get('size') or spec.get("size") or 0,
            "level": "matched", "source": "netease-match", "md5": "",
            "durationMs": duration, "expectedDurationMs": expected, "matchSource": info.get('source') or '',
            "sr": info.get('sr') or spec.get("sr") or 0, "bits": info.get('bits') or spec.get("bits") or 0, "ch": info.get('ch') or spec.get("ch") or 0}


_LRC_TAG = re.compile(r"\[(\d+):(\d+)(?:[.:](\d+))?\]")


def _parse_lrc(s):
    """经典 LRC → [(毫秒, 文本)]，一行多时间标签逐个展开（翻译/罗马音字段也用）。"""
    out = []
    for line in (s or "").splitlines():
        for mm, ss, frac in _LRC_TAG.findall(line):
            t = int(mm) * 60000 + int(ss) * 1000 + int((frac or "0").ljust(3, "0")[:3])
            out.append((t, _LRC_TAG.sub("", line).strip()))
    return sorted(out)


_YRC_HEAD = re.compile(r"^\[(\d+),\d+\]")
_YRC_TOKEN = re.compile(r"\((\d+),(\d+),\d+\)")


def _parse_yrc_words(payload):
    """解析 YRC 逐词 token，按 token 边界切文本。

    不能用 ``[^()]*`` 捕获词文本：英文歌词常含括号（如 ``(Oh)``），
    旧正则会把括号后的内容截断并造成整行/翻译时间错位。
    """
    ms = list(_YRC_TOKEN.finditer(payload or ""))
    out = []
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(payload)
        text = payload[m.end():end]
        if text:
            out.append([int(m.group(1)), text])
    return out

# 逐字/逐词解析（与 _parse_yrc 同源，但保留每个字/词的时间戳与 JSON 形态的逐字时间）
_YRC_JSON = re.compile(r'^\{"t":(\d+),')


def _parse_lines_ex(s):
    """逐行解析 → [(毫秒, 行文本, [[毫秒, 字/词], ...])]；无逐字时间时第三项为空列表。
    支持：JSON 元数据行、经典 LRC 行、逐字 YRC 文本行（(起,时长,0)字…）。"""
    out = []
    for line in (s or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            t = int(obj.get("t") or 0)
            items = obj.get("l") or obj.get("c") or []
            txt_parts, words = [], []
            for w in items:
                tx = w.get("tx") if isinstance(w, dict) else str(w)
                if tx is None:
                    continue
                txt_parts.append(tx)
                wt = w.get("t") if isinstance(w, dict) else None
                if isinstance(wt, int) or (isinstance(wt, str) and wt.isdigit()):
                    words.append([int(wt), tx])
            out.append((t, "".join(txt_parts), words if len(words) == len(txt_parts) else []))
        elif _LRC_TAG.search(line):
            text = _LRC_TAG.sub("", line).strip()
            for mm, ss, frac in _LRC_TAG.findall(line):
                out.append((int(mm) * 60000 + int(ss) * 1000 + int((frac or "0").ljust(3, "0")[:3]), text, []))
        else:
            m = _YRC_HEAD.match(line)
            if not m:
                continue
            words = _parse_yrc_words(line[m.end():])
            out.append((int(m.group(1)), "".join(w[1] for w in words), words))
    return sorted(out, key=lambda x: x[0])


def _parse_lines(s):
    """逐行自适应解析 → [(毫秒, 行文本)]，按时间排序。
    同一字段可能混三种行：JSON 元数据（{"t":ms,"c":[{"tx":..}]}）、
    经典 LRC（[00:12.340]文本）、逐字 YRC（[起,时长](字起,字时,0)字…）。
    按行首特征区分：冒号时间标签=LRC、逗号时间头=YRC、{=JSON。"""
    out = []
    for line in (s or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            words = obj.get("l") or obj.get("c") or []
            out.append((int(obj.get("t") or 0), "".join(w.get("tx", "") for w in words)))
        elif _LRC_TAG.search(line):
            text = _LRC_TAG.sub("", line).strip()
            for mm, ss, frac in _LRC_TAG.findall(line):
                out.append((int(mm) * 60000 + int(ss) * 1000
                            + int((frac or "0").ljust(3, "0")[:3]), text))
        else:
            m = _YRC_HEAD.match(line)
            if m:
                txt = "".join(w[1] for w in _parse_yrc_words(line[m.end():]))
                out.append((int(m.group(1)), txt))
    return sorted(out)


def _merge_aux(lines, aux, tol=350):
    """按时间把翻译/罗马音合并到主歌词行，返回「主行索引 → 文本」。

    主轨（YRC）与辅助轨（LRC）时间戳精度常不一致（如 12.340/12.351），
    且英文/日文歌词可能出现同一毫秒多行；旧版用 dict 丢掉重复时间戳并按
    时间键回填，容易把翻译错配到相邻行。现在按时间最近邻做一对一消费，
    并以主行索引回填，保证渲染行与翻译 1:1。
    """
    if not aux:
        return {}
    items = sorted(aux.items()) if isinstance(aux, dict) else sorted(aux)
    used = set()
    out = {}
    import bisect
    keys = [t for t, _ in items]
    for idx, (t, _) in enumerate(lines):
        # 不只检查相邻 4 个元素：同一时间点可能有多行（中文合唱/重复时间戳），
        # 旧窗口会在第 5 行开始漏翻译。按容差窗口扫描全部未消费候选，取最近邻。
        lo = bisect.bisect_left(keys, t - tol)
        hi = bisect.bisect_right(keys, t + tol)
        candidates = sorted(
            (abs(keys[j] - t), j) for j in range(lo, hi) if j not in used
        )
        if candidates:
            _, j = candidates[0]
            used.add(j)
            out[idx] = items[j][1]
    return out


def _norm_lyric_key(s):
    """歌词文本归一化（用于跨轨文本匹配）：折叠空白、去首尾。"""
    # 防御：调用方可能误传非字符串（解析异常时），不能因此抛错
    return re.sub(r"\s+", " ", str(s or "").replace("\u3000", " ")).strip()


def _aux_coverage(lines, aux, tol=350):
    """aux（翻译/罗马音）能按时间落到 lines 上的比例（0~1）。"""
    if not aux or not lines:
        return 0.0
    import bisect
    keys = [t for t, _ in lines]
    hit = 0
    for t, _ in aux:
        lo = bisect.bisect_left(keys, t - tol)
        hi = bisect.bisect_right(keys, t + tol)
        if hi > lo:
            hit += 1
    return hit / len(aux)


def _merge_aux_by_text(main_lines, base_lines, aux, tol=350):
    """把 aux 合并到 main_lines：先与 base_lines 按时间对齐，再按**文本**映射过来。

    为什么需要这一步（用户反馈"部分英文歌词翻译显示不全"）：
    同一首歌的 YRC（逐字）与 LRC 是**同一份歌词、两套时间轴**——实测 Someone Like
    You 的 lrc-yrc 行时间差中位 -931ms、最大 1705ms 且 67 个互不相同的值（不是
    常数偏移）；而 tlyric 只与 **LRC** 精确对齐（中位 0ms）。旧实现固定拿 YRC 当
    基准做时间最近邻，于是 68 条翻译有 55 条超出容差被丢弃 → 显示不全。
    两轨文本一致时按文本映射最稳，剩下的（文本有出入）再退回时间最近邻。
    """
    if not aux:
        return {}
    base_map = _merge_aux([(t, x) for t, x in base_lines], aux, tol=tol)
    from collections import defaultdict, deque
    by_text = defaultdict(deque)
    for idx, (_t, x) in enumerate(base_lines):
        if idx in base_map:
            by_text[_norm_lyric_key(x)].append(base_map[idx])
    out = {}
    for idx, (_t, x) in enumerate(main_lines):
        q = by_text.get(_norm_lyric_key(x))
        if q:
            out[idx] = q.popleft()
    gaps = {i: v for i, v in _merge_aux(main_lines, aux, tol=tol).items() if i not in out}
    out.update(gaps)
    return out


def _aux_for(main_lines, lrc_lines, aux, tol=350):
    """选**对得上的那一轨**做基准，再映射到渲染轨（main_lines）。"""
    if not aux:
        return {}
    # 注意用 >= 而非 >：覆盖度持平时也要走文本映射——副歌重复的行（同一句出现
    # 多次）只有按文本才能各拿到自己那条翻译，纯时间最近邻会漏掉。
    use_lrc = bool(lrc_lines) and _aux_coverage(lrc_lines, aux, tol) >= _aux_coverage(main_lines, aux, tol)
    if use_lrc:
        return _merge_aux_by_text(main_lines, lrc_lines, aux, tol=tol)
    return _merge_aux(main_lines, aux, tol=tol)


_LYRIC_TOKEN_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u9fff]|[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|.", re.S)


def _synth_words(text, start, end):
    """LRC 没有逐字时间轴时，按行时长估算每个字/词的起点。

    日语/中文按单字、英文按单词切分；行的起止来自相邻 LRC 行。估算不是官方
    逐字数据，但能让绝大多数没有 YRC 的日语歌也有逐字点亮，而不是整行一起亮。
    """
    tokens = _LYRIC_TOKEN_RE.findall(text or "")
    if not tokens:
        return []
    weights = [max(0.35, float(len(tok.strip()) or 0.5)) for tok in tokens]
    total = sum(weights) or 1.0
    span = max(500.0, min(8000.0, float(end - start)))
    cursor = float(start)
    out = []
    for tok, w in zip(tokens, weights):
        out.append([int(round(cursor)), tok])
        cursor += span * w / total
    return out


def lyric(ncm_id):
    """归一化歌词：官方 YRC → LDDC 逐字源 → 自研逐字估算。

    网易云官方 YRC 始终优先；没有官方逐字数据时，才向本机 LDDC 桥接服务
    询问逐字歌词（QQ/酷狗/网易云等源），最后才使用按行时长估算的 ``w``。
    LDDC 不可用/没匹配时行为与旧版完全一致，不影响歌词可用性。
    """
    try:
        d = call("/lyric/new", {"id": int(ncm_id)}, timeout=20.0, retries=1)
    except NcmError:
        d = call("/lyric", {"id": int(ncm_id)}, timeout=20.0, retries=1)
    yrc_raw = ((d or {}).get("yrc") or {}).get("lyric") or ""
    lrc_raw = ((d or {}).get("lrc") or {}).get("lyric") or ""
    raw = yrc_raw or lrc_raw
    parsed = [l for l in _parse_lines_ex(raw) if l[1] or l[0] == 0]
    # YRC 字段偶尔只返回元数据/残缺行：不要让残缺 YRC 把完整 LRC 遮掉。
    if yrc_raw and lrc_raw and len(parsed) < 2:
        parsed = [l for l in _parse_lines_ex(lrc_raw) if l[1] or l[0] == 0]
        yrc_raw = ""       # 实际用了 LRC：允许 LDDC 补逐字，而不是把残缺 YRC 当官方数据
    lines = [(t, x) for t, x, _ in parsed]
    # LRC 轨另存一份：翻译/罗马音常只与它精确对齐（见 _merge_aux_by_text 注释）
    lrc_parsed = [l for l in _parse_lines_ex(lrc_raw) if l[1] or l[0] == 0]
    lrc_lines = [(t, x) for t, x, _ in lrc_parsed]
    if not lrc_lines or lrc_raw == raw:
        lrc_lines = None
    trans = _aux_for(lines, lrc_lines, _parse_lrc(((d or {}).get("tlyric") or {}).get("lyric") or ""))
    roma = _aux_for(lines, lrc_lines, _parse_lrc(((d or {}).get("romalrc") or {}).get("lyric") or ""))
    out = []
    for idx, (t, x, words) in enumerate(parsed):
        item = {"t": t, "txt": x, "trans": trans.get(idx, ""), "roma": roma.get(idx, "")}
        if not words and x:
            nxt = parsed[idx + 1][0] if idx + 1 < len(parsed) else t + 5000
            words = _synth_words(x, t, nxt)
            if words:
                item["wSynth"] = True
        if words:                      # 官方 YRC 逐字时间轴；无官方数据时用上面的估算
            item["w"] = words
        out.append(item)
    is_yrc = bool(yrc_raw)
    result = {
        "lines": out,
        "isYrc": is_yrc,
        "source": "ncm:yrc" if is_yrc else ("ncm:lrc" if out else "none"),
        "wordLevel": is_yrc,
    }

    if not is_yrc:
        texts = [(line.get("txt") or "").strip() for line in out if (line.get("txt") or "").strip()]
        instrumental = len(texts) <= 3 and any("纯音乐" in text or "instrumental" in text.lower()
                                               for text in texts)
        if instrumental:
            result["source"] = "ncm:inst"
            result["instrumental"] = True
        else:
            try:
                meta = song_detail([int(ncm_id)])
                if meta:
                    # 网易云只有制作人员/纯音乐提示时，允许 LDDC 的逐行歌词兜底；
                    # 正常歌词则只接受真正的逐字结果，避免覆盖本地估算轴。
                    real_lines = sum(1 for line in out if (line.get("txt") or "").strip())
                    external = cm_lddc.fetch(meta[0], allow_line=real_lines < 3)
                    merged = cm_lddc.merge_with_base(result, external)
                    if merged:
                        result = merged
            except Exception as exc:  # noqa: BLE001 外部歌词源失败不能影响主流程
                logging.getLogger("cm.ncm").warning("LDDC 歌词回退失败 id=%s: %s", ncm_id, exc)

    cm_lddc.ensure_words(result["lines"])
    # 双语 LRC 常见「原文一行、中文译文一行」：先合并成 txt + trans，再做时间轴清洗。
    result["lines"] = cm_lddc.merge_bilingual(result["lines"])
    # 出口统一清洗（官方 YRC / LDDC / 估算全部经过）：制作名单行、同起始逐字
    # token、end<=start、相邻行同 t——任何一条都会让 CurrentMusicX 的解析器
    # 丢 token 或把制作名单当歌词唱出来（用户反馈的「歌词显示错乱」即源于此）。
    result["lines"] = cm_lddc.finalize_lines(result["lines"])
    return result


def song_wiki(ncm_id):
    """歌曲百科归一化：把上游 blocks 拼装结构压成「章节 + 字段 + 正文」。

    上游 /song/wiki/info 的 data.blocks[0].rnData 是页面级拼装数据，嵌套很深
    （blocks[].blockInfo.{blockName,desc,wikiSubElementVos[].{title,wikiSubMetaVos[].text}}），
    前端直接解析既脆又难读，这里统一成：
      {name, artist, album, cover, sections:[{name, fields:[[标题, 值]], desc}]}
    """
    d = call("/song/wiki/info", {"id": int(ncm_id)}, timeout=20.0, retries=1)
    data = (d or {}).get("data") or {}
    blocks = data.get("blocks") or []
    top = (blocks[0].get("rnData") or {}) if blocks else {}
    out = {
        "name": top.get("songName") or "",
        "artist": top.get("artistName") or "",
        "album": top.get("albumName") or "",
        "cover": _https(top.get("coverImage") or ""),
        "sections": [],
    }
    for b in (top.get("blocks") or []):
        bi = b.get("blockInfo") or {}
        name = (bi.get("blockName") or "").strip()
        fields = []
        for el in (bi.get("wikiSubElementVos") or []):
            title = (el.get("title") or "").strip()
            vals = []
            for m in (el.get("wikiSubMetaVos") or []):
                if not isinstance(m, dict):
                    continue
                v = m.get("text") or m.get("name") or m.get("title") or ""
                if v:
                    vals.append(str(v).strip())
            if title and vals:
                fields.append([title, "、".join(dict.fromkeys(vals))[:200]])
        desc = (bi.get("desc") or "").strip()
        if name and (fields or desc):
            out["sections"].append({"name": name, "fields": fields, "desc": desc})
    return out


def comment_count(ncm_id):
    """评论总数 + 最热评论点赞数（网易云公开口径中唯一可取的「点赞数」）。
    取 limit=20 以获得热评列表。"""
    d = call("/comment/music", {"id": int(ncm_id), "limit": 20})
    hot = (d or {}).get("hotComments") or []
    top_liked = 0
    top_text = ""
    for h in hot:
        if (h.get("likedCount") or 0) > top_liked:
            top_liked = h.get("likedCount") or 0
            top_text = (h.get("content") or "")[:60]
    return {"total": (d or {}).get("total") or 0, "hot": len(hot),
            "topLiked": top_liked, "topText": top_text}


def _norm_comment(c):
    u = c.get("user") or {}
    be = (c.get("beReplied") or [None])[0] or {}
    return {
        "id": c.get("commentId") or c.get("id"),
        "userId": u.get("userId") or 0,
        "nickname": u.get("nickname") or "",
        "avatar": _https(u.get("avatarUrl") or ""),
        "content": c.get("content") or "",
        "time": c.get("time") or 0,
        "liked": c.get("likedCount") or 0,
        "beNickname": (be.get("user") or {}).get("nickname") or "",
        "beContent": be.get("content") or "",
        "replyCount": c.get("replyCount") or (len(c.get("beReplied") or []) and 0) or 0,
    }


def comment_list(ncm_id, offset=0, limit=20):
    """歌曲评论区（最新 comments；首页附 hotComments 精简）。"""
    d = call("/comment/music", {"id": int(ncm_id), "limit": int(limit), "offset": int(offset)}, timeout=15.0)
    out = {
        "total": (d or {}).get("total") or 0,
        "more": bool((d or {}).get("more") and ((d or {}).get("comments") or [])),
        "comments": [_norm_comment(c) for c in ((d or {}).get("comments") or [])],
    }
    if offset == 0:
        out["hot"] = [_norm_comment(c) for c in ((d or {}).get("hotComments") or [])[:10]]
    return out


COMMENT_SORTS = {"recommended": 99, "hot": 2, "latest": 3}


def _comment_data(path, params, cookie):
    response = call(path, params, cookie=cookie, with_cookie=False, bypass_cache=cookie is not None)
    if not isinstance(response, dict):
        raise NcmError("网易云评论响应格式无效")
    if response.get("code") in (301, 401):
        raise NcmError("网易云绑定已失效，请重新绑定", status_code=401)
    data = response.get("data")
    if response.get("code") != 200 or not isinstance(data, dict):
        raise NcmError("网易云暂时无法返回评论，请稍后重试")
    return data


def _normalize_comment_page(data, cookie, parent_id=None):
    rows = data.get("comments")
    if rows is not None and not isinstance(rows, list):
        raise NcmError("网易云评论列表格式无效")
    comments = []
    for comment in rows or []:
        if not isinstance(comment, dict):
            continue
        row = _norm_comment(comment)
        cid = str(row["id"])
        if not re.fullmatch(r"[1-9][0-9]{0,19}", cid) or cid == parent_id:
            continue
        row["id"] = cid
        row["likedByMe"] = cookie is not None and comment.get("liked") is True
        floor = comment.get("showFloorComment") or {}
        row["replyCount"] = comment.get("replyCount") or floor.get("replyCount") or 0
        comments.append(row)
    return {"comments": comments, "total": data.get("totalCount") or 0,
            "more": bool(data.get("hasMore") and comments), "nextCursor": None}


def comment_page(resource_id, type_id, sort, page, limit, cursor=None, cookie=None):
    params = {"id": resource_id, "type": type_id, "sortType": COMMENT_SORTS[sort],
              "pageNo": page, "pageSize": limit}
    if cursor is not None:
        params["cursor"] = cursor
    data = _comment_data("/comment/new", params, cookie)
    result = _normalize_comment_page(data, cookie)
    if sort == "latest":
        next_cursor = str(data.get("cursor") or "")
        result["more"] = result["more"] and next_cursor not in ("", "0", cursor)
        if result["more"]:
            result["nextCursor"] = next_cursor
    return result


def comment_replies(resource_id, type_id, parent_id, limit, cursor=None, cookie=None):
    params = {"id": resource_id, "type": type_id, "parentCommentId": parent_id, "limit": limit}
    if cursor is not None:
        params["time"] = cursor
    data = _comment_data("/comment/floor", params, cookie)
    result = _normalize_comment_page(data, cookie, parent_id=parent_id)
    next_cursor = str(data.get("time") or "")
    result["more"] = result["more"] and next_cursor not in ("", "0", "-1", cursor)
    if result["more"]:
        result["nextCursor"] = next_cursor
    return result


def comment_post(cookie, ncm_id, content, comment_id=None, real_ip=None):
    """以绑定账号发送歌曲评论或回复（type=0 歌曲）。
    注意：本 fork(api-enhanced) 的 /comment 不认 commentId，回复必须走 /comment/reply。"""
    if comment_id:
        # 本 fork 的回复正道是 /comment 的 t=2（xeapi /comment/reply 实测 250 不可用）
        p = {"t": 2, "type": 0, "id": int(ncm_id), "commentId": int(comment_id), "content": content, "timestamp": _ts()}
    else:
        p = {"t": 1, "type": 0, "id": int(ncm_id), "content": content, "timestamp": _ts()}
    d = call("/comment", p, cookie=cookie, timeout=15.0, real_ip=real_ip)
    code = (d or {}).get("code")
    if code != 200:
        raise NcmError(f"评论发送失败: {(d or {}).get('message') or (d or {}).get('msg') or code}")
    return ((d or {}).get("comment") or {}).get("commentId") or True


def comment_like(cookie, ncm_id, comment_id, like=True, real_ip=None):
    """点赞/取消点赞一条评论（本 fork 走 /comment/like：t=1 点赞 / t=0 取消，type=0 歌曲）。"""
    d = call("/comment/like", {"t": 1 if like else 0, "type": 0, "id": int(ncm_id),
                               "cid": int(comment_id), "timestamp": _ts()}, cookie=cookie,
             timeout=15.0, real_ip=real_ip)
    code = (d or {}).get("code")
    if code != 200:
        raise NcmError(f"评论点赞失败: {(d or {}).get('message') or code}")
    return True


def comment_floor(ncm_id, comment_id, limit=20, offset=0):
    """某条评论的回复列表（楼层）。"""
    d = call("/comment/floor", {"parentCommentId": int(comment_id), "id": int(ncm_id),
                                "type": 0, "limit": int(limit), "offset": int(offset),
                                "timestamp": _ts()}, timeout=15.0)
    data = (d or {}).get("data") or {}
    return {
        "total": data.get("totalCount") or 0,
        "comments": [_norm_comment(c) for c in (data.get("comments") or [])],
        "more": bool(data.get("hasMore")),
    }


def search_hot():
    """热搜榜（简洁列表）。"""
    d = call("/search/hot", {}, timeout=12.0)
    hots = (((d or {}).get("result") or {}).get("hots")) or []
    out = []
    for h in hots[:15]:
        out.append({"name": h.get("first") or "", "score": h.get("second") or 0})
    return [x for x in out if x["name"]]


def comment_delete(cookie, ncm_id, comment_id, real_ip=None):
    d = call("/comment", {"t": 0, "type": 0, "id": int(ncm_id), "commentId": int(comment_id),
                          "timestamp": _ts()}, cookie=cookie, timeout=15.0, real_ip=real_ip)
    code = (d or {}).get("code")
    if code != 200:
        raise NcmError(f"评论删除失败: {(d or {}).get('message') or code}")
    return True


def recommend_daily():
    """NCM 每日推荐（30 首），依赖服务器 SVIP cookie。"""
    d = call("/recommend/songs")
    songs = (((d or {}).get("data") or {}).get("dailySongs")) or []
    return [_norm_song(s, pop=s.get("pop") or 0) for s in songs]


# ---------- 网易云账号绑定（扫码登录 + 该账号的歌单拉取） ----------

def _ts():
    return int(time.time() * 1000)


def qr_key():
    """生成扫码登录 key（登录端点，不带服务器 cookie）。"""
    d = call("/login/qr/key", {"timestamp": _ts()}, with_cookie=False)
    return ((d or {}).get("data") or {}).get("unikey") or ""


def qr_img(key):
    """二维码图片（base64 data url）。"""
    d = call("/login/qr/create", {"key": key, "qrimg": 1, "timestamp": _ts()}, with_cookie=False)
    return ((d or {}).get("data") or {}).get("qrimg") or ""


def qr_check(key):
    """轮询扫码状态：800 过期 / 801 待扫码 / 802 已扫待确认 / 803 成功（含 cookie）。"""
    return call("/login/qr/check", {"key": key, "timestamp": _ts()}, with_cookie=False, timeout=10.0)


def phone_send_captcha(phone, ctcode="86"):
    """向手机号发送验证码（上游会真的发短信）。"""
    d = call("/captcha/sent", {"phone": str(phone), "ctcode": str(ctcode or "86")},
             with_cookie=False, timeout=15.0)
    code = (d or {}).get("code")
    if code != 200:
        msg = (d or {}).get("message") or (d or {}).get("msg") or f"错误码 {code}"
        # 网易云经常用 HTTP 200 承载业务拒绝（如 code=400 当日限额），
        # 明确标记为客户端业务错误，避免项目网关误报 502。
        status = int(code) if isinstance(code, int) and 400 <= code < 500 else None
        raise NcmError(f"验证码发送失败：{msg}", status_code=status)
    return True


def phone_verify_captcha(phone, captcha, ctcode="86"):
    """校验手机验证码（仅校验，不建立登录态）。

    上游对「码错误」也用 code=503，与风控 503 的区别在 message 字段，
    故按 message 判定：含「验证码」即码本身的问题（返回 False），
    其余 503/异常按风控抛出。
    """
    d = call("/captcha/verify",
             {"phone": str(phone), "captcha": str(captcha), "ctcode": str(ctcode or "86")},
             with_cookie=False, timeout=15.0)
    code = (d or {}).get("code")
    if code == 200:
        return True
    msg = (d or {}).get("message") or (d or {}).get("msg") or ""
    if "验证码" in msg:
        return False
    raise NcmError(f"验证码校验失败：{msg or f'错误码 {code}'}，请稍后重试")


def parse_login_status(d):
    """解析上游 /login/status 响应（两种形状都支持）。

    上游有两种返回：``{code: 200, data: {...}}`` 与 ``{data: {code: 200, account, profile}}``。
    只看顶层 code 会把后者误判成「未登录」（code=None）——曾导致**所有有效绑定被标成
    stale**，第三方客户端因此以为用户没同步网易云登录态。
    """
    data = (d or {}).get("data") or {}
    code = (d or {}).get("code")
    if code is None:
        code = data.get("code")
    # 只有 code=200 不够：必须带 account/profile，否则是「未登录」的空壳
    has_identity = bool(data.get("account") or data.get("profile"))
    return {"code": code, "ok": code == 200 and has_identity, "data": data}


def login_status(cookie):
    """用调用者自己的 cookie 查网易云登录态（上游 /login/status）。

    这是**绑定是否还有效**的权威判据：cookie 过期时上游会给出非 200 的 code，
    项目侧据此把绑定标记为 stale，用户就能看到「已失效」而不是各种接口莫名的 401。
    """
    return parse_login_status(call("/login/status", cookie=cookie, timeout=15.0))


def login_refresh(cookie):
    """刷新网易云登录 token（上游 /login/refresh），成功时返回新的 cookie 串。

    上游在 body 里回带 `cookie`（刷新后的完整 cookie）。拿不到就当刷新失败 ——
    不做「没变也算成功」的模糊处理，否则用户会以为刷新了其实还是旧的。
    """
    d = call("/login/refresh", cookie=cookie, timeout=15.0)
    code = (d or {}).get("code")
    new_cookie = (d or {}).get("cookie") or ""
    if code != 200:
        msg = (d or {}).get("message") or (d or {}).get("msg") or f"错误码 {code}"
        raise NcmError(f"刷新登录态失败：{msg}")
    if not new_cookie:
        raise NcmError("上游未返回新 cookie，请重新扫码绑定")
    return new_cookie


def phone_login(phone, captcha, ctcode="86"):
    """手机号 + 验证码登录，返回 cookie 字符串。"""
    d = call("/login/cellphone",
             {"phone": str(phone), "captcha": str(captcha), "countrycode": str(ctcode or "86")},
             with_cookie=False, timeout=15.0)
    code = (d or {}).get("code")
    if code != 200:
        msg = (d or {}).get("message") or (d or {}).get("msg") or f"错误码 {code}"
        raise NcmError(f"登录失败：{msg}")
    cookie = (d or {}).get("cookie") or ""
    if not cookie:
        raise NcmError("登录成功但未取得 cookie")
    return cookie


def user_account(cookie):
    d = call("/user/account", cookie=cookie)
    prof = (d or {}).get("profile") or {}
    return {
        "code": (d or {}).get("code"),
        "uid": prof.get("userId") or 0,
        "nickname": prof.get("nickname") or "",
        "avatar": prof.get("avatarUrl") or "",
    }


def user_playlists(cookie, uid):
    """绑定账号的全部歌单（自建 + 收藏），字段精简。

    ``order`` 是上游返回顺序的 0 基下标。网易云 App「我的 → 音乐」就是按这条
    列表展示（我喜欢的音乐 → 自建 → 收藏），同步端必须原样保存，不能按导入
    完成时间重排。
    """
    d = call("/user/playlist", {"uid": int(uid), "limit": 100}, cookie=cookie)
    out = []
    for i, p in enumerate(((d or {}).get("playlist") or [])[:100]):
        out.append({
            "ncm_pl_id": p.get("id"), "name": p.get("name") or "",
            "cover": p.get("coverImgUrl") or "", "track_count": p.get("trackCount") or 0,
            "order": i,
        })
    return out


def like_song(cookie, ncm_id, like=True, real_ip=None):
    """红心/取消红心到绑定的网易云账号。"""
    data = post_json("/like", {"id": int(ncm_id), "like": "true" if like else "false"},
                     cookie=cookie, timeout=12.0, real_ip=real_ip)
    _check_like_result(data, (200, 100000, 100001))
    return True


def _check_like_result(data, accepted=(200,)):
    data = data if isinstance(data, dict) else {}
    code = data.get("code")
    if code not in accepted:
        raise NcmError("网易云未能更新这首歌的红心，请稍后重试",
                       status_code=code if isinstance(code, int) else None, response=data)


def set_song_like(cookie, uid, ncm_id, like=True, real_ip=None):
    """常规红心失败时，使用已核实的本人红心歌单，返回备用路径写入的歌单 ID。"""
    try:
        like_song(cookie, ncm_id, like, real_ip=real_ip)
        return None
    except NcmError as error:
        pid = str(error.response.get("playlistId") or "")
        # /radio/like 对部分曲目返回 500，并带当前账号的红心歌单 ID。
        # 登录失效、限流和普通网络错误不能据此尝试另一条写入路径。
        if error.status_code != 500 or error.response.get("code") != 500 or not pid.isdecimal() or not uid:
            raise

    data = post_json("/user/playlist", {"uid": uid, "limit": 10}, cookie=cookie, timeout=8.0)
    playlists = data.get("playlist") if isinstance(data, dict) and data.get("code") == 200 else None
    if not isinstance(playlists, list) or not any(
        isinstance(p, dict) and str(p.get("id")) == pid and str(p.get("userId")) == str(uid)
        and p.get("specialType") == 5 and not p.get("subscribed")
        for p in playlists
    ):
        raise NcmError("未能确认网易云绑定账号的「我喜欢」歌单，红心更新失败")
    data = post_json("/playlist/tracks", {"pid": int(pid), "tracks": str(ncm_id), "op": "add" if like else "del"},
                     cookie=cookie, timeout=12.0, real_ip=real_ip)
    # api-enhanced 的 playlist/tracks 在正常路径会多包一层 body。
    result = data.get("body", data) if isinstance(data, dict) else data
    _check_like_result(result)
    return int(pid)


def likelist(cookie, uid):
    """绑定账号的红心歌单 id 列表。"""
    d = call("/likelist", {"uid": int(uid)}, cookie=cookie, timeout=12.0)
    ids = (d or {}).get("ids") or []
    if isinstance(ids, list):
        return [int(i) for i in ids]
    return []


def red_count(ncm_id):
    """网易云歌曲红心总数（公开接口，不需要 cookie）。失败返回 0。"""
    d = call("/song/red/count", {"id": int(ncm_id)}, timeout=10.0, retries=1)
    data = (d or {}).get("data") or {}
    try:
        return max(0, int(data.get("count") or 0))
    except (TypeError, ValueError):
        return 0


def playlist_full(cookie, pid):
    """/playlist/detail 一次带全 tracks 完整数组（实测 557 首热查询 2~5s，冷查询可达 20s+）。
    大歌单（如「我喜欢的音乐」）冷查询易超时：给 25s 超时 + 1 次重试（重试时上游已预热），
    仍拿不到 tracks 时回退 /playlist/track/all。"""
    pl = {}
    try:
        d = call("/playlist/detail", {"id": int(pid)}, cookie=cookie, timeout=25.0, retries=1)
        pl = (d or {}).get("playlist") or {}
    except NcmError:
        pl = {}
    songs = [_norm_song(s, pop=s.get("pop") or 0) for s in (pl.get("tracks") or [])[:1000]]
    if not songs:
        # 回退通道 1：track/all（一次拿全部元数据）
        try:
            d = call("/playlist/track/all", {"id": int(pid), "limit": 1000}, cookie=cookie, timeout=25.0, retries=0)
            songs = [_norm_song(s, pop=s.get("pop") or 0) for s in ((d or {}).get("songs") or [])[:1000]]
        except NcmError:
            songs = []
    if not songs:
        # 回退通道 2：trackIds + song/detail 分批
        ids = [t.get("id") for t in (pl.get("trackIds") or [])[:1000] if t.get("id")]
        songs = []
        for i in range(0, len(ids), 100):
            chunk = ids[i:i + 100]
            try:
                dd = call("/song/detail", {"ids": ",".join(str(int(x)) for x in chunk)},
                          cookie=cookie, timeout=25.0, retries=0)
                songs.extend(_norm_song(s, pop=s.get("pop") or 0) for s in ((dd or {}).get("songs") or []))
            except NcmError:
                continue
    return {"name": pl.get("name") or "", "cover": _https(pl.get("coverImgUrl") or ""), "songs": songs}
