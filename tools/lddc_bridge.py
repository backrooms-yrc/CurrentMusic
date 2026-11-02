#!/usr/bin/env python3
"""LDDC 本机歌词桥接服务（独立进程，GPL-3.0 边界）。

LDDC 在独立 venv 中运行；本服务只暴露 127.0.0.1 上的 JSON 接口，供
CurrentMusic 后端在“网易云没有官方 YRC”时获取逐字歌词：

    POST /lyrics  {title, artists, album, duration, ncmId, allowLine}
    GET  /health

返回的歌词已经过归一化/清洗，但最终的质量判定、与网易云翻译的合并由
backend/cm_lddc.py 负责。

LDDC 本身是 GPL-3.0-only，源码不随本项目分发；安装脚本见
deploy/install-lddc.sh。
"""
from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LDDC_SRC = os.environ.get("LDDC_SRC", "/opt/lddc/src")
HEADLESS = Path(__file__).resolve().parent / "lddc_headless"

sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(HEADLESS))
sys.path.insert(0, LDDC_SRC)

import cm_lddc  # noqa: E402

log = logging.getLogger("lddc-bridge")

TOKEN = os.environ.get("LDDC_TOKEN", "")
DEADLINE = float(os.environ.get("LDDC_DEADLINE", "5.0"))
CACHE_TTL = float(os.environ.get("LDDC_CACHE_TTL", str(12 * 3600)))
MAX_CACHE = int(os.environ.get("LDDC_CACHE_MAX", "512"))
SOURCE_PRIORITY = tuple(
    s.strip().upper() for s in os.environ.get("LDDC_SOURCES", "KG,NE,QM,LRCLIB").split(",")
    if s.strip()
)

_cache = {}
_cache_lock = threading.Lock()
_started = time.time()
_lddc_version = "unknown"
_import_error = None


def _load_lddc():
    global _lddc_version, _import_error
    try:
        import LDDC.common.version as version
        from LDDC.common.models import SearchType, SongInfo, Source
        from LDDC.core.algorithm import calculate_artist_score, calculate_title_score, text_difference
        from LDDC.core.api.lyrics import get_lyrics, get_lyricslist, lyrics_api, search

        _lddc_version = version.__version__
        return {
            "SearchType": SearchType,
            "SongInfo": SongInfo,
            "Source": Source,
            "calculate_artist_score": calculate_artist_score,
            "calculate_title_score": calculate_title_score,
            "text_difference": text_difference,
            "get_lyrics": get_lyrics,
            "get_lyricslist": get_lyricslist,
            "lyrics_api": lyrics_api,
            "search": search,
        }
    except Exception as exc:  # noqa: BLE001 启动阶段给出可诊断错误
        _import_error = f"{type(exc).__name__}: {exc}"
        log.exception("LDDC 导入失败")
        return None


API = _load_lddc()


def _source(name):
    return getattr(API["Source"], name, None) if API else None


def _payload(data):
    out = []
    for line in data or []:
        words = []
        for word in line.words or []:
            words.append({"start": word.start, "end": word.end, "text": word.text})
        out.append({"start": line.start, "end": line.end, "words": words})
    return out


def _score(meta, item):
    """与 LDDC auto_fetch 同口径的标题/歌手/专辑/时长打分。"""
    duration = getattr(item, "duration", None)
    if meta["duration"] and duration and abs(meta["duration"] - duration) > 5000:
        return -1.0
    title = getattr(item, "title", None) or ""
    title_score = API["calculate_title_score"](meta["title"], title)
    artist = str(getattr(item, "artist", "") or "")
    artist_score = (API["calculate_artist_score"](meta["artist_text"], artist)
                    if meta["artist_text"] and artist else None)
    album = getattr(item, "album", None) or ""
    album_score = (max(API["text_difference"](meta["album"].lower(), album.lower()) * 100, 0)
                   if meta["album"] and album else None)
    if artist_score is not None:
        if album_score is not None:
            score = max(title_score * 0.5 + artist_score * 0.5,
                        title_score * 0.5 + artist_score * 0.35 + album_score * 0.15)
        else:
            score = title_score * 0.5 + artist_score * 0.5
        # 歌手门禁：元数据有歌手且候选也报了歌手时，歌手分太低一律拒绝——
        # 「同名异曲」（翻唱/改编/DJ 版）正是整轨歌词错乱的来源，标题再像也不能要。
        if artist_score < 45:
            return -1.0
    elif meta["artist_text"] and not artist:
        # 候选没报歌手：只有时长能对上才可信；时长也缺失时不敢确认，拒绝。
        if not (meta["duration"] and duration and abs(meta["duration"] - duration) <= 5000):
            return -1.0
        score = title_score
    elif album_score:
        score = max(title_score * 0.7 + album_score * 0.3, title_score * 0.8)
    else:
        score = title_score
    if title_score < 30:
        score = max(0.0, score - 35)
    return score


def _search_candidates(src, meta, keyword):
    try:
        result = API["search"](src, keyword, API["SearchType"].SONG)
        items = list(result)
    except Exception as exc:  # noqa: BLE001 单个歌词源失败不影响其它源
        log.info("%s 搜索失败：%s", src.name, str(exc)[:180])
        return []
    scored = []
    for item in items:
        try:
            score = _score(meta, item)
        except Exception:
            continue
        if score > 55:
            scored.append((score, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


def _candidate_lyrics(src, song, meta):
    """取一个候选歌曲的歌词；酷狗多试一条候选歌词。"""
    infos = []
    if src.name == "KG":
        try:
            infos = list(API["get_lyricslist"](song))[:2]
        except Exception:
            infos = []
    if infos:
        for info in infos:
            try:
                yield API["get_lyrics"](info)
            except Exception as exc:  # noqa: BLE001
                log.info("KG 歌词候选失败：%s", str(exc)[:150])
                continue
    else:
        yield API["get_lyrics"](song)


def _try_source(src, meta, allow_line, deadline):
    full_keyword = f"{meta['artist_text']} - {meta['title']}" if meta["artist_text"] else meta["title"]
    keywords = [full_keyword]
    if full_keyword != meta["title"]:
        keywords.append(meta["title"])

    seen = set()
    for keyword in keywords:
        if time.monotonic() >= deadline:
            return None
        for score, song in _search_candidates(src, meta, keyword)[:4]:
            key = (src.name, str(getattr(song, "id", "")), getattr(song, "title", None),
                   str(getattr(song, "artist", "")), getattr(song, "duration", None))
            if key in seen:
                continue
            seen.add(key)
            if time.monotonic() >= deadline:
                return None
            try:
                lyrics = API["get_lyrics"](song) if src.name != "KG" else None
                iterator = ([lyrics] if lyrics else _candidate_lyrics(src, song, meta))
                for lyric in iterator:
                    if time.monotonic() >= deadline:
                        return None
                    fs = lyric.get_fslyrics(meta["duration"] or getattr(song, "duration", None))
                    payload = {
                        "orig": _payload(fs.get("orig")),
                        "ts": _payload(fs.get("ts")),
                        "roma": _payload(fs.get("roma")),
                        "source": f"lddc:{src.name}",
                    }
                    normalized = cm_lddc.normalize_provider_lyrics(
                        payload, meta, allow_line=allow_line)
                    if not normalized:
                        continue
                    normalized["score"] = round(score, 1)
                    normalized["match"] = {
                        "title": getattr(song, "title", None),
                        "artist": str(getattr(song, "artist", "") or ""),
                        "album": getattr(song, "album", None),
                        "duration": getattr(song, "duration", None),
                        "id": getattr(song, "id", None),
                    }
                    return normalized
            except Exception as exc:  # noqa: BLE001
                log.info("%s 取词失败：%s", src.name, str(exc)[:180])
                continue
    return None


def lookup(body):
    title = str(body.get("title") or "").strip()[:200]
    artists = body.get("artists") or []
    if not isinstance(artists, list):
        artists = [artists]
    artists = [str(a).strip()[:100] for a in artists if str(a).strip()][:8]
    album = str(body.get("album") or "").strip()[:200]
    try:
        duration = int(body.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    duration = max(0, min(duration, 3_600_000))
    allow_line = bool(body.get("allowLine"))
    if not title:
        raise ValueError("title 不能为空")
    if not API:
        raise RuntimeError(f"LDDC 未就绪：{_import_error or '导入失败'}")

    meta = {
        "title": title,
        "artists": artists,
        "artist_text": "/".join(artists[:4]),
        "album": album,
        "duration": duration,
    }
    cache_key = (title.lower(), tuple(a.lower() for a in artists), album.lower(), duration, allow_line)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit and now - hit[0] < CACHE_TTL:
            result = dict(hit[1])
            result["cached"] = True
            return result

    deadline = time.monotonic() + DEADLINE
    result = None
    for name in SOURCE_PRIORITY:
        if time.monotonic() >= deadline:
            break
        src = _source(name)
        if not src:
            continue
        result = _try_source(src, meta, allow_line, deadline)
        if result:
            break

    if not result:
        return {"ok": True, "found": False}
    result["ok"] = True
    result["found"] = True
    result["cached"] = False
    with _cache_lock:
        if len(_cache) >= MAX_CACHE:
            oldest = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest, None)
        _cache[cache_key] = (now, result)
    return result


def _json(handler, status, data):
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.wfile.write(raw)
    handler.close_connection = True


class Handler(BaseHTTPRequestHandler):
    server_version = "CurrentMusic-LDDCBridge/1.0"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def _authorized(self):
        if not TOKEN:
            return True
        supplied = self.headers.get("X-CM-LDDC-Token", "")
        return hmac.compare_digest(supplied.encode("utf-8"), TOKEN.encode("utf-8"))

    def do_GET(self):
        if self.path == "/health":
            with _cache_lock:
                size = len(_cache)
            return _json(self, 200, {
                "ok": bool(API),
                "service": "currentmusic-lddc-bridge",
                "lddcVersion": _lddc_version,
                "sources": list(SOURCE_PRIORITY),
                "cacheEntries": size,
                "uptimeSeconds": int(time.time() - _started),
                "error": _import_error,
            })
        _json(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/lyrics":
            return _json(self, 404, {"ok": False, "error": "not found"})
        if not self._authorized():
            return _json(self, 403, {"ok": False, "error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            return _json(self, 400, {"ok": False, "error": "invalid body"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
            data = lookup(body)
        except (ValueError, UnicodeError) as exc:
            return _json(self, 400, {"ok": False, "error": str(exc)[:200]})
        except Exception as exc:  # noqa: BLE001
            log.exception("处理歌词请求失败")
            return _json(self, 500, {"ok": False, "error": str(exc)[:200]})
        _json(self, 200, data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description="CurrentMusic LDDC bridge")
    parser.add_argument("--host", default=os.environ.get("LDDC_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("LDDC_PORT", "3015")))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if args.host not in ("127.0.0.1", "::1", "localhost") and not TOKEN:
        log.warning("监听非回环地址但未设置 LDDC_TOKEN，请勿把该端口暴露到公网")

    home = os.environ.get("HOME")
    if home:
        Path(home).mkdir(parents=True, exist_ok=True)

    def warm():
        try:
            API["lyrics_api"].init()
            log.info("LDDC providers 预热完成")
        except Exception:
            log.exception("LDDC providers 预热失败（首次请求时重试）")

    if API:
        threading.Thread(target=warm, name="lddc-warm", daemon=True).start()

    server = Server((args.host, args.port), Handler)
    log.info("LDDC bridge 已启动：%s:%s（LDDC %s，源 %s）",
             args.host, args.port, _lddc_version, ",".join(SOURCE_PRIORITY))

    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        log.info("LDDC bridge 已停止")


if __name__ == "__main__":
    main()
