"""Private staged screenshots and recordings for Bug feedback."""
import hashlib
import importlib.util
import json
import logging
import math
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import cm_db
import cm_feedback_diagnostics as diagnostics

log = logging.getLogger("cm")
IMAGE_BYTES = 2 * 1024 ** 2
VIDEO_BYTES = 25 * 1024 ** 2
TOTAL_BYTES = 3 * IMAGE_BYTES + VIDEO_BYTES
STAGING_TTL = 3600
SLOTS = {f"screenshot-{n}": ("image/jpeg", "image/png") for n in range(1, 4)}
SLOTS["video-1"] = ("video/mp4",)
EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4"}
_OBJECT = re.compile(r"[0-9a-f]{32}\.(jpg|png|mp4)")
_WORKER = Path(__file__).resolve().with_name("cm_feedback_media_worker.py")
_UPLOADS = threading.BoundedSemaphore(2)
_ACCOUNT_LOCK = threading.Lock()
_UPLOADING = set()
_UNAVAILABLE = "媒体处理或存储暂不可用"


class MediaError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


def directory():
    parent = diagnostics.directory()
    if parent is not None:
        root = parent / "media"
        try:
            mode = root.lstat().st_mode
        except OSError:
            return None
        if stat.S_ISDIR(mode) and not mode & 0o077 and os.access(root, os.W_OK | os.X_OK):
            return root
    return None


def enabled(host):
    # The operator enables each origin only after its proxy can forward the raw PUT.
    hosts = {name.strip().lower() for name in os.environ.get("CM_FEEDBACK_MEDIA_HOSTS", "").split(",")}
    return bool(host and host.strip().lower() in hosts and directory() and diagnostics.public_origin()
                and os.environ.get("CM_FEEDBACK_GITHUB_TOKEN", "").strip()
                and importlib.util.find_spec("PIL") and shutil.which("ffprobe") and shutil.which("ffmpeg"))


def capabilities(host):
    return {
        "enabled": enabled(host),
        "screenshot": {"maxCount": 3, "maxBytes": IMAGE_BYTES, "contentTypes": list(SLOTS["screenshot-1"]),
                       "maxLongEdge": 4096, "maxPixels": 12_000_000},
        "video": {"maxCount": 1, "maxBytes": VIDEO_BYTES, "contentTypes": list(SLOTS["video-1"]),
                  "maxDurationSeconds": 30, "maxLongEdge": 1920, "maxShortEdge": 1080},
        "maxTotalBytes": TOTAL_BYTES,
        "stagingTtlSeconds": STAGING_TTL,
    }


def manifest(body):
    if "media" not in body and "mediaConsent" not in body:
        return ()
    entries = body.get("media")
    if body.get("mediaConsent") is not True or not isinstance(entries, list) or not 1 <= len(entries) <= len(SLOTS):
        raise MediaError(400, "请确认媒体授权并提交有效的附件清单")
    by_slot = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.keys() != {"slot", "sha256"}:
            raise MediaError(400, "媒体清单每项须包含 slot 和 sha256")
        slot, sha256 = entry["slot"], entry["sha256"]
        if (not isinstance(slot, str) or slot not in SLOTS or slot in by_slot
                or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256)):
            raise MediaError(400, "媒体清单包含无效或重复的槽位或摘要")
        by_slot[slot] = sha256
    return tuple(sorted(by_slot.items()))


def _published(conn, uid, request_id, now, retention):
    return conn.execute("SELECT 1 FROM feedback_receipts WHERE user_id=? AND request_id=? AND created_at>?",
                        (uid, request_id, now - retention)).fetchone() is not None


def _require_unsubmitted(conn, uid, request_id, now, retention):
    if _published(conn, uid, request_id, now, retention):
        raise MediaError(409, "反馈已提交，附件已锁定", "request_conflict")


def _staged(conn, uid, request_id, slot):
    return conn.execute("SELECT * FROM feedback_media WHERE user_id=? AND request_id=? AND slot=? AND group_id IS NULL",
                        (uid, request_id, slot)).fetchone()


def _stage_receipt(row):
    expires = datetime.fromtimestamp(row["expires_at"], timezone.utc).isoformat().replace("+00:00", "Z")
    return {"slot": row["slot"], "sha256": row["upload_sha256"], "expiresAt": expires}


@contextmanager
def _upload_slot(uid):
    with _ACCOUNT_LOCK:
        if uid in _UPLOADING:
            raise MediaError(429, "请等待当前附件上传完成")
        if not _UPLOADS.acquire(blocking=False):
            raise MediaError(429, "媒体上传繁忙，请稍后重试")
        _UPLOADING.add(uid)
    try:
        yield
    finally:
        with _ACCOUNT_LOCK:
            _UPLOADING.remove(uid)
            _UPLOADS.release()


def _admit(conn, uid, request_id, declared, now, repeated):
    window = conn.execute("SELECT window_at,attempts FROM feedback_media_quota WHERE user_id=?", (uid,)).fetchone()
    if window and window["window_at"] > now - STAGING_TTL and window["attempts"] >= 20:
        raise MediaError(429, "该账号暂存上传次数已达上限")
    if not repeated:
        total, drafts, in_request = conn.execute(
            "SELECT COALESCE(SUM(source_size),0), COUNT(DISTINCT CASE WHEN request_id<>? THEN request_id END),"
            " COALESCE(SUM(CASE WHEN request_id=? THEN source_size END),0) FROM feedback_media"
            " WHERE user_id=? AND group_id IS NULL AND expires_at>?",
            (request_id, request_id, uid, now),
        ).fetchone()
        if in_request + declared > TOTAL_BYTES:
            raise MediaError(413, "该反馈的媒体总大小超过 31 MiB")
        if total + declared > 2 * TOTAL_BYTES or drafts >= 3:
            raise MediaError(429, "该账号的媒体暂存配额已满")
    if window and window["window_at"] > now - STAGING_TTL:
        conn.execute("UPDATE feedback_media_quota SET attempts=attempts+1 WHERE user_id=?", (uid,))
    else:
        conn.execute("INSERT OR REPLACE INTO feedback_media_quota VALUES(?,?,1)", (uid, now))


def _read_body(handler, target, length):
    remaining = length
    checksum = hashlib.sha256()
    deadline = time.monotonic() + 90
    socket = getattr(handler, "connection", None)
    previous = socket.gettimeout() if socket else None
    try:
        with target.open("xb") as handle:
            while remaining:
                wait = deadline - time.monotonic()
                if wait <= 0:
                    raise TimeoutError
                if socket:
                    socket.settimeout(min(15, wait))
                data = handler.rfile.read1(min(65536, remaining))
                if not data:
                    raise MediaError(400, "媒体上传已中断，请重试原文件")
                handle.write(data)
                checksum.update(data)
                remaining -= len(data)
    except TimeoutError as exc:
        raise MediaError(408, "媒体上传超时，请重试原文件") from exc
    finally:
        if socket:
            socket.settimeout(previous)
    return checksum.hexdigest()


def _process(args, size, timeout, stdout=subprocess.DEVNULL, *, work):
    try:
        result = subprocess.run([sys.executable, str(_WORKER), str(size), *map(str, args)],
                                stdout=stdout, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                env={"PATH": os.defpath, "LANG": "C", "HOME": str(work)}, cwd=work,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MediaError(503, "媒体处理超时，请重试或移除附件") from exc
    if result.returncode in (13, -signal.SIGXFSZ):
        raise MediaError(413, "处理后的媒体超过大小限制")
    if result.returncode == 15:
        raise MediaError(415, "声明的媒体类型与文件格式不符")
    if result.returncode in (3, -signal.SIGXCPU, -signal.SIGKILL):
        raise MediaError(503, _UNAVAILABLE)
    if result.returncode:
        raise MediaError(422, "媒体损坏或超出允许的尺寸、时长")


def _video(source, target):
    probe, ffmpeg = shutil.which("ffprobe"), shutil.which("ffmpeg")
    if not probe or not ffmpeg:
        raise MediaError(503, _UNAVAILABLE)
    # Restrict the demuxer, protocols and MOV data references before opening user bytes.
    input_args = ["-max_alloc", "67108864", "-protocol_whitelist", "file", "-enable_drefs", "0",
                  "-use_absolute_path", "0", "-f", "mov", "-max_streams", "16"]
    with source.open("rb") as handle:
        if handle.read(8)[4:] != b"ftyp":
            raise MediaError(415, "录屏须为 MP4 容器")
    with tempfile.TemporaryFile(dir=source.parent) as report:
        _process(["exec", probe, "-v", "error", *input_args, "-show_entries",
                  "format=duration:format_tags=major_brand:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic",
                  "-of", "json", str(source)], 65536, 10, report, work=source.parent)
        report.seek(0)
        try:
            info = json.load(report)
        except (ValueError, UnicodeError) as exc:
            raise MediaError(422, "无法读取录屏文件") from exc
    format_info = info.get("format", {})
    if format_info.get("tags", {}).get("major_brand", "").strip() in ("", "qt", "M4A"):
        raise MediaError(415, "录屏须为 MP4 容器")
    streams = info.get("streams", [])
    video = next((s for s in streams if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s["codec_type"] == "audio"), None)
    if video is None or video.get("codec_name") != "h264" or (audio and audio.get("codec_name") != "aac"):
        raise MediaError(415, "录屏须为 H.264 视频，音轨须为 AAC")
    short, long = sorted((video.get("width", 0), video.get("height", 0)))
    try:
        durations = [float(format_info["duration"]), float(video.get("duration", format_info["duration"]))]
    except (ValueError, TypeError, KeyError) as exc:
        raise MediaError(422, "无法读取录屏时长") from exc
    if not (0 < short <= 1080 and 0 < long <= 1920) or any(not math.isfinite(d) or not 0 < d <= 30 for d in durations):
        raise MediaError(422, "录屏最长 30 秒，最大 1920×1080 或 1080×1920")
    mapping = ["-map", f"0:{video['index']}"]
    if audio:
        mapping += ["-map", f"0:{audio['index']}"]
    try:
        _process(["exec", ffmpeg, "-nostdin", "-v", "error", "-xerror", *input_args, "-i", source,
                  *mapping, "-c", "copy", "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
                  "-bsf:v", "filter_units=remove_types=6", "-movflags", "+faststart", "-f", "mp4", target],
                 VIDEO_BYTES, 15, work=source.parent)
    except MediaError as exc:
        if exc.status == 422 and target.is_file() and target.stat().st_size >= VIDEO_BYTES:
            raise MediaError(413, "处理后的媒体超过大小限制") from exc
        raise
    # Stream copy removes container metadata but cannot detect corrupt H.264/AAC bitstreams.
    _process(["exec", ffmpeg, "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
              *input_args, "-threads", "1", "-i", target, "-map", "0:v:0", "-map", "0:a:0?",
              "-threads", "1", "-filter_threads", "1", "-f", "null", "-"],
             VIDEO_BYTES, 35, work=source.parent)


def _prepare(source, target, kind, limit):
    if kind == "video/mp4":
        _video(source, target)
    else:
        _process(["screenshot", source, target, kind, 4096, 12_000_000], limit, 12, work=source.parent)
    target.chmod(0o600)
    with target.open("rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        if not 0 < size <= limit:
            raise MediaError(413, "处理后的媒体超过大小限制")
        checksum = hashlib.file_digest(handle, "sha256").hexdigest()
        os.fsync(handle.fileno())
    return size, checksum


def _check_replay(row, digest, kind):
    if row["upload_sha256"] != digest or row["content_type"] != kind:
        raise MediaError(409, "该槽位已有不同的文件，请先移除")


def upload(handler, uid, request_id, slot, retention):
    if not enabled(handler.headers.get("Host")):
        raise MediaError(503, _UNAVAILABLE)
    if handler.headers.get("X-Feedback-Media-Consent") != "true":
        raise MediaError(400, "请确认同意上传媒体供管理员查看")
    kind = handler.headers.get("Content-Type", "").split(";", 1)[0].lower().strip()
    if kind not in SLOTS[slot]:
        raise MediaError(415, "媒体类型不适用于此槽位")
    length = handler.headers.get("Content-Length", "")
    if (handler.headers.get("Transfer-Encoding") or handler.headers.get("Content-Encoding")
            or not re.fullmatch(r"[0-9]{1,12}", length) or not int(length)):
        raise MediaError(400, "媒体上传须提供有效的 Content-Length")
    length = int(length)
    limit = VIDEO_BYTES if kind == "video/mp4" else IMAGE_BYTES
    if length > limit:
        raise MediaError(413, "媒体文件超过大小限制")
    root = directory()
    if root is None:
        raise MediaError(503, _UNAVAILABLE)
    with _upload_slot(uid):
        with closing(cm_db.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            now = int(time.time())
            _require_unsubmitted(conn, uid, request_id, now, retention)
            previous = _staged(conn, uid, request_id, slot)
            _admit(conn, uid, request_id, length, now, previous is not None and previous["expires_at"] > now)

        with tempfile.TemporaryDirectory(prefix=".media-", dir=root) as temp:
            source, target = Path(temp) / "source", Path(temp) / "clean"
            digest = _read_body(handler, source, length)
            with closing(cm_db.connect()) as conn:
                now = int(time.time())
                _require_unsubmitted(conn, uid, request_id, now, retention)
                previous = _staged(conn, uid, request_id, slot)
                if previous and previous["expires_at"] > now:
                    _check_replay(previous, digest, kind)
                    if (root / previous["object_key"]).is_file():
                        return 200, _stage_receipt(previous)
            size, checksum = _prepare(source, target, kind, limit)
            identifier = uuid.uuid4().hex
            final = root / f"{identifier}.{EXTENSIONS[kind]}"
            stored = False
            try:
                with closing(cm_db.connect()) as conn, conn:
                    conn.execute("BEGIN IMMEDIATE")
                    now = int(time.time())
                    _require_unsubmitted(conn, uid, request_id, now, retention)
                    previous = _staged(conn, uid, request_id, slot)
                    if previous:
                        if previous["expires_at"] > now:
                            _check_replay(previous, digest, kind)
                            if (root / previous["object_key"]).is_file():
                                return 200, _stage_receipt(previous)
                        conn.execute("DELETE FROM feedback_media WHERE id=?", (previous["id"],))
                    target.replace(final)
                    stored = True
                    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                    expires = now + STAGING_TTL
                    conn.execute("INSERT INTO feedback_media VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
                                 (identifier, uid, request_id, slot, kind, digest, length, final.name, checksum, size, expires))
            except (OSError, sqlite3.Error):
                if stored:
                    diagnostics.remove(final)
                raise
            return 201, _stage_receipt({"slot": slot, "upload_sha256": digest, "expires_at": expires})


def delete(uid, request_id, slot, retention):
    with _upload_slot(uid), closing(cm_db.connect()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        _require_unsubmitted(conn, uid, request_id, time.time(), retention)
        row = _staged(conn, uid, request_id, slot)
        if row is None:
            return
        root = directory()
        if root is None or not diagnostics.remove(root / row["object_key"]):
            raise MediaError(503, _UNAVAILABLE)
        conn.execute("DELETE FROM feedback_media WHERE id=?", (row["id"],))


def claim(conn, uid, request_id, entries, group, now, expires):
    root = directory()
    conn.execute("INSERT INTO feedback_media_groups VALUES(?,?)", (group, expires))
    for slot, digest in entries:
        row = _staged(conn, uid, request_id, slot)
        if (row is None or row["expires_at"] <= now or row["upload_sha256"] != digest
                or root is None or not (root / row["object_key"]).is_file()):
            raise MediaError(409, "部分媒体附件尚未就绪，请重新上传或移除", "media_not_ready")
        conn.execute("UPDATE feedback_media SET group_id=?, expires_at=? WHERE id=?", (group, expires, row["id"]))


def attachments(group):
    with closing(cm_db.connect()) as conn:
        rows = conn.execute("SELECT id,size,slot,content_type FROM feedback_media WHERE group_id=? ORDER BY slot", (group,)).fetchall()
        media_group = conn.execute("SELECT expires_at FROM feedback_media_groups WHERE id=?", (group,)).fetchone()
        zip_row = conn.execute("SELECT expires_at,size FROM feedback_diagnostics WHERE id=?", (group,)).fetchone()
    if media_group is None and zip_row is None:
        raise MediaError(404, "未找到诊断附件")
    if (media_group or zip_row)["expires_at"] <= time.time():
        raise MediaError(410, "诊断附件已过期")
    files = [{"id": row["id"], "slot": row["slot"], "contentType": row["content_type"], "size": row["size"]} for row in rows]
    if zip_row:
        files.append({"id": group, "slot": "diagnostics", "contentType": "application/zip", "size": zip_row["size"]})
    return {"attachments": files}


@contextmanager
def download(identifier):
    with closing(cm_db.connect()) as conn:
        row = conn.execute("SELECT * FROM feedback_media WHERE id=? AND group_id IS NOT NULL", (identifier,)).fetchone()
    if row is None:
        raise MediaError(404, "未找到媒体附件")
    if row["expires_at"] <= time.time():
        raise MediaError(410, "媒体附件已过期")
    root = directory()
    if root is None or not row["object_key"]:
        raise MediaError(503, _UNAVAILABLE)
    with (root / row["object_key"]).open("rb") as handle:
        if os.fstat(handle.fileno()).st_size != row["size"]:
            raise MediaError(503, _UNAVAILABLE)
        yield row, handle


def purge(expiry_notice):
    root = directory()
    if root is None:
        return
    now = int(time.time())
    with closing(cm_db.connect()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        for row in conn.execute("SELECT id,object_key,group_id FROM feedback_media WHERE expires_at<=? AND object_key IS NOT NULL", (now,)).fetchall():
            if not diagnostics.remove(root / row["object_key"]):
                continue
            if row["group_id"]:
                conn.execute("UPDATE feedback_media SET object_key=NULL WHERE id=?", (row["id"],))
            else:
                conn.execute("DELETE FROM feedback_media WHERE id=?", (row["id"],))
        conn.execute("DELETE FROM feedback_media WHERE object_key IS NULL AND expires_at<=?", (now - expiry_notice,))
        conn.execute("DELETE FROM feedback_media_groups WHERE expires_at<=?"
                     " AND NOT EXISTS (SELECT 1 FROM feedback_media m WHERE m.group_id=feedback_media_groups.id)",
                     (now - expiry_notice,))
        conn.execute("DELETE FROM feedback_media_quota WHERE window_at<=?", (now - STAGING_TTL,))
        referenced = {row[0] for row in conn.execute("SELECT object_key FROM feedback_media WHERE object_key IS NOT NULL")}
        for path in root.iterdir():
            if _OBJECT.fullmatch(path.name) and path.name not in referenced:
                diagnostics.remove(path)
            elif re.fullmatch(r"\.media-[a-z0-9_]{8}", path.name) and path.stat().st_mtime < now - 600:
                shutil.rmtree(path, ignore_errors=True)
