"""Bounded multipart uploads, ZIP validation and private diagnostic objects."""
import hashlib
import io
import json
import logging
import os
import re
import stat
import tempfile
import threading
import time
import zipfile
import zlib
from contextlib import contextmanager
from ipaddress import IPv6Address
from pathlib import Path
from urllib.parse import urlsplit

try:
    import multipart
except ImportError:
    multipart = None

MAX_ZIP = 2 * 1024 * 1024
MAX_EXPANDED = 4 * 1024 * 1024
MAX_BODY = MAX_ZIP + 64 * 1024
OBJECT_NAME = re.compile(r"[0-9a-f]{32}\.zip|\.upload-[a-z0-9_]{8}")
_UPLOADS = threading.BoundedSemaphore(4)
log = logging.getLogger("cm")
_FIELDS = {"requestId": 32, "content": 8000, "public": 4, "diagnosticsConsent": 4,
           "diagnostics": MAX_ZIP, "mediaConsent": 4, "media": 2048}
_REQUIRED_FIELDS = _FIELDS.keys() - {"mediaConsent", "media"}
_ENTRIES = {"diagnostics.txt", "logs.txt"}
_PRIVATE = re.compile(
    r"(?:https?://|www\.)[^\s<>\"，。！？；）]+"
    r"|(?<![\w.+%-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b"
    r"|(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"
    r"|\b(?:gh[pousr]_|github_pat_|sk-)[A-Z0-9_-]{12,}"
    r"|\beyJ[A-Z0-9_-]+\.[A-Z0-9_-]+\.[A-Z0-9_-]+"
    r"|\bBearer[ \t]+[^\s,;\"']+"
    r"|(?<![\w.-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.-])"
    r"|(?<![\w:])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![\w:])",
    re.IGNORECASE,
)
_IPV6 = re.compile(r"(?<![\w:])(?=[0-9a-f:]{0,4}:)[0-9a-f:]{2,39}(?![\w:])", re.IGNORECASE)
_SECRET_LINE = re.compile(
    r"\b(?:cookie|set-cookie|authorization|password|passwd|[\w-]{0,48}token|api[_ -]?key|"
    r"music_[ua]|__csrf|android[_ -]?id|imei|serial[_ -]?number)[\"']?[ \t]*[:=：][^\r\n]*"
    r"|(?:密码|令牌|手机号|邮箱)[\"']?[ \t]*[:=：][^\r\n]*",
    re.IGNORECASE,
)
_PEM = re.compile(r"-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,32}PRIVATE KEY-----|\Z)")
_INVALID_ZIP = "诊断附件须为包含 diagnostics.txt 和 logs.txt 的 UTF-8 ZIP"
_UNAVAILABLE = "诊断附件存储暂不可用"


class DiagnosticsError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@contextmanager
def upload_slot():
    if not _UPLOADS.acquire(blocking=False):
        raise DiagnosticsError(503, "诊断附件上传繁忙，请稍后再试")
    try:
        yield
    finally:
        _UPLOADS.release()


def read_upload(handler):
    if multipart is None:
        raise DiagnosticsError(503, "诊断附件上传暂不可用")
    length = handler.headers.get("Content-Length", "")
    if handler.headers.get("Transfer-Encoding") or handler.headers.get("Content-Encoding"):
        raise DiagnosticsError(400, "诊断附件须以固定长度的 multipart 请求上传")
    if not re.fullmatch(r"[0-9]{1,20}", length) or int(length) == 0:
        raise DiagnosticsError(400, "诊断附件请求缺少有效的 Content-Length")
    length = int(length)
    if length > MAX_BODY:
        raise DiagnosticsError(413, "诊断附件请求体过大")
    content_type = handler.headers.get("Content-Type", "")
    if len(content_type) > 512:
        raise DiagnosticsError(400, "诊断附件 multipart 格式无效")
    _, params = multipart.parse_options_header(content_type)
    boundary = params.get("boundary", "")
    if not re.fullmatch(r"[a-zA-Z0-9'()+_,./:=? -]{1,70}", boundary) or boundary.endswith(" "):
        raise DiagnosticsError(400, "诊断附件 multipart boundary 无效")

    parts = {}
    remaining = length
    deadline = time.monotonic() + 30
    connection = getattr(handler, "connection", None)
    original_timeout = connection.gettimeout() if connection else None

    def read(size):
        nonlocal remaining
        timeout = deadline - time.monotonic()
        if timeout <= 0:
            raise TimeoutError()
        if connection:
            connection.settimeout(min(10, timeout))
        chunk = handler.rfile.read1(size)
        remaining -= len(chunk)
        return chunk

    try:
        parser = multipart.PushMultipartParser(boundary, content_length=length,
                                               max_segment_count=len(_FIELDS))
        for event in parser.parse_blocking(read):
            if isinstance(event, multipart.MultipartSegment):
                name = event.name
                if (name not in _FIELDS or name in parts or event.disposition != "form-data"
                        or len({key for key, _ in event.headerlist}) != len(event.headerlist)
                        or event.header("Content-Transfer-Encoding") is not None
                        or (name == "diagnostics" and (not event.filename or event.content_type != "application/zip"))
                        or (name != "diagnostics" and (event.filename is not None
                            or event.content_type not in (None, "text/plain")
                            or (event.charset or "utf-8").lower() != "utf-8"))):
                    raise DiagnosticsError(400, "诊断附件 multipart 字段无效")
                part = parts[name] = bytearray()
            elif event is not None:
                if len(part) + len(event) > _FIELDS[name]:
                    code = 413 if name == "diagnostics" else 400
                    raise DiagnosticsError(code, "诊断附件 multipart 字段过长")
                part.extend(event)
        if not _REQUIRED_FIELDS <= parts.keys() or remaining:
            raise DiagnosticsError(400, "诊断附件 multipart 字段缺失或请求体不完整")
        archive = parts.pop("diagnostics")
        fields = {name: value.decode("utf-8") for name, value in parts.items()}
    except (multipart.MultipartError, UnicodeError) as exc:
        raise DiagnosticsError(400, "诊断附件 multipart 格式无效") from exc
    except TimeoutError as exc:
        raise DiagnosticsError(408, "诊断附件上传超时") from exc
    except OSError as exc:
        raise DiagnosticsError(400, "诊断附件请求体不完整") from exc
    finally:
        if connection:
            connection.settimeout(original_timeout)

    if fields["diagnosticsConsent"] != "true":
        raise DiagnosticsError(400, "请确认诊断附件可供项目维护者查看")
    fields["public"] = fields["public"] == "true"
    if "mediaConsent" in fields:
        fields["mediaConsent"] = fields["mediaConsent"] == "true"
    if "media" in fields:
        try:
            fields["media"] = json.loads(fields["media"])
        except (ValueError, RecursionError) as exc:
            raise DiagnosticsError(400, "媒体清单须为 UTF-8 JSON 数组") from exc
    return fields, archive


def sanitize_zip(raw):
    if len(raw) > MAX_ZIP:
        raise DiagnosticsError(413, "诊断附件压缩大小不能超过 2 MiB")
    if not raw.startswith(b"PK\x03\x04"):
        raise DiagnosticsError(400, _INVALID_ZIP)
    output = io.BytesIO()
    saved_size = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as source, \
                zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as target:
            files = source.infolist()
            if (len(files) != len(_ENTRIES) or {f.orig_filename for f in files} != _ENTRIES
                    or any(f.flag_bits & ~0x080e or f.external_attr & 0x18
                           or stat.S_IFMT(f.external_attr >> 16) not in (0, stat.S_IFREG)
                           or f.compress_type not in (zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED) for f in files)):
                raise DiagnosticsError(400, _INVALID_ZIP)
            if sum(f.file_size for f in files) > MAX_EXPANDED:
                raise DiagnosticsError(413, "诊断附件解压总量不能超过 4 MiB")
            for item in files:
                data = source.read(item).decode("utf-8-sig")
                if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", data):
                    raise DiagnosticsError(400, _INVALID_ZIP)
                data = _PEM.sub("[REDACTED]", data)
                data = _SECRET_LINE.sub("[REDACTED]", data)
                data = _IPV6.sub(_redact_ipv6, data)
                clean = _PRIVATE.sub("[REDACTED]", data).encode("utf-8")
                saved_size += len(clean)
                if saved_size > MAX_EXPANDED:
                    raise DiagnosticsError(413, "诊断附件脱敏后解压总量超过 4 MiB")
                target.writestr(item.filename, clean)
    except (zipfile.BadZipFile, ValueError, EOFError, RuntimeError, zlib.error) as exc:
        raise DiagnosticsError(400, _INVALID_ZIP) from exc
    if output.tell() > MAX_ZIP:
        raise DiagnosticsError(413, "诊断附件脱敏后压缩大小超过 2 MiB")
    return output.getvalue()


def _redact_ipv6(match):
    try:
        IPv6Address(match[0])
    except ValueError:
        return match[0]
    return "[REDACTED]"


def directory():
    configured = os.environ.get("CM_FEEDBACK_DIAGNOSTICS_DIR", "").strip()
    path = Path(configured)
    if not path.is_absolute():
        return None
    try:
        mode = path.lstat().st_mode
    except OSError:
        return None
    if stat.S_ISDIR(mode) and not mode & 0o077 and os.access(path, os.W_OK | os.X_OK):
        return path
    return None


def public_origin():
    origin = os.environ.get("CM_FEEDBACK_DIAGNOSTICS_ORIGIN", "").strip().rstrip("/")
    try:
        parsed = urlsplit(origin)
        if (parsed.scheme == "https" and not parsed.path and not parsed.query and not parsed.fragment
                and re.fullmatch(r"[a-zA-Z0-9.-]+(?::[0-9]{1,5})?", parsed.netloc)
                and parsed.port != 0):
            return f"https://{parsed.netloc}"
    except ValueError:
        pass
    return None


def store(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".upload-", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise DiagnosticsError(503, _UNAVAILABLE) from exc
    finally:
        if temporary is not None:
            remove(temporary)


def remove(path):
    try:
        path.unlink(missing_ok=True)
        return True
    except OSError as exc:
        log.warning("诊断附件清理失败（%s）", type(exc).__name__)
        return False


def load(path, size, sha256):
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_ZIP + 1)
    except OSError as exc:
        raise DiagnosticsError(503, _UNAVAILABLE) from exc
    if len(data) != size or hashlib.sha256(data).hexdigest() != sha256:
        raise DiagnosticsError(503, _UNAVAILABLE)
    return data
