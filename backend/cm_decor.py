"""头像挂件（avatar decoration）目录与图片托管。

素材来源：dc.hhhl.cc（Universe Federation / Sharkey）公开接口 `/api/get-avatar-decorations`，
已随仓库固化在 `decorations/manifest.json`（402 项元数据 + sha256）。

图片两种存放位置（都按 `file` 字段的 `.gif/.png/.apng` 命名）：
  1. `data/decorations/`   —— 运行时的完整素材（推荐；由 tools/sync-decorations.py 落盘）
  2. `decorations/assets/` —— 随仓库分发的素材（若存在则优先使用）

两侧都没有该文件时，`open_image()` 会按 manifest 里的 `source_url` 回源抓取并缓存到
`data/decorations/`，因此即使素材目录没同步全也能自愈；源站不可用时返回 None（路由 404）。
"""
import hashlib
import json
import os
import re
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CM_DATA_DIR", os.path.join(ROOT, "data"))

# 挂件清单（随仓库分发；含名称/文件名/尺寸/校验值，不含图片本体）
MANIFEST = os.environ.get("CM_DECOR_MANIFEST", os.path.join(ROOT, "decorations", "manifest.json"))

# 图片目录：data/ 为运行时目录（可写、可回源缓存），decorations/assets 为随仓库分发的副本
IMAGE_DIRS = [d for d in (
    os.environ.get("CM_DECOR_DIR"),
    os.path.join(DATA_DIR, "decorations"),
    os.path.join(ROOT, "decorations", "assets"),
) if d]
CACHE_DIR = IMAGE_DIRS[0] if IMAGE_DIRS else os.path.join(DATA_DIR, "decorations")

FORMATS = {"gif": "image/gif", "png": "image/png", "apng": "image/apng"}
SAFE_ID = re.compile(r"^[a-z0-9]{4,32}$")
_UA = {"User-Agent": "CurrentMusic/1.0 (+avatar-decoration)"}

# 挂件放大比例：把「设计中的头像尺寸」（素材可见范围）放大到等于头像直径。
# 素材留白程度不一（0.09~1.0），故按款实测并夹在合理区间，缺失时用全体中位数。
SCALE_DEFAULT = 1.56
SCALE_MIN, SCALE_MAX = 1.0, 2.6


def _norm_scale(v):
    try:
        s = float(v)
    except (TypeError, ValueError):
        return SCALE_DEFAULT
    if s <= 0:
        return SCALE_DEFAULT
    return round(max(SCALE_MIN, min(SCALE_MAX, s)), 2)

_lock = threading.Lock()
_catalog = []          # [{id,name,description,format,file,...}]，按 manifest 顺序
_by_id = {}            # id → 条目
_manifest_stamp = (0, 0)   # (mtime, size) 用于 lru 式重载


# ---------- 清单加载 ----------

def _load_manifest(force=False):
    """读取 manifest.json；文件未变化时复用内存副本。"""
    global _catalog, _by_id, _manifest_stamp
    try:
        st = os.stat(MANIFEST)
        stamp = (int(st.st_mtime), st.st_size)
    except OSError:
        with _lock:
            _catalog, _by_id, _manifest_stamp = [], {}, (0, 0)
        return []
    with _lock:
        if not force and stamp == _manifest_stamp and _catalog:
            return _catalog
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return []
    items, seen = [], {}
    for i, x in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(x, dict):
            continue
        did = str(x.get("id") or "").strip()
        if not SAFE_ID.match(did) or did in seen:
            continue
        fname = os.path.basename(str(x.get("file") or ""))       # 防目录穿越
        fmt = os.path.splitext(fname)[1].lstrip(".").lower() or "gif"
        if fmt not in FORMATS:
            fmt = "gif"
        if not fname:
            fname = f"{did}.{fmt}"
        seen[did] = True
        items.append({
            "id": did, "name": str(x.get("name") or did)[:80],
            "description": str(x.get("description") or "")[:200],
            "format": fmt, "file": fname,
            "width": int(x.get("width") or 0), "height": int(x.get("height") or 0),
            # CSS 放大比例：素材自带透明留白，圆环外径只占画布一部分，需按实测比例放大
            "scale": _norm_scale(x.get("scale")),
            "source_url": str(x.get("source_url") or ""),
            "bytes": int(x.get("bytes") or 0),
            "sha256": str(x.get("sha256") or ""),
            "sort": i,
        })
    with _lock:
        _catalog, _by_id, _manifest_stamp = items, {x["id"]: x for x in items}, stamp
    return items


def catalog():
    """全部挂件元数据（含内存缓存）。"""
    if not _catalog:
        _load_manifest()
    return _catalog


def catalog_version():
    """目录版本号：清单内容变化时随之变化，供前端判断本地缓存的比例表是否过期。
    与 web/build.mjs 对 manifest.json 的算法一致（同样的 id:scale 串行 SHA1 前 12 位），
    这样随包基线比例表与线上目录能对上版本。"""
    items = catalog()
    if not items:
        return ""            # 目录不可用时不参与版本比对（前端退回基线，不误判为过期）
    h = hashlib.sha1()
    for x in items:
        # 用固定两位小数参与哈希：Python 的 float→str 会把 1.0 写成 "1.0"，
        # 而 build.mjs（JS）写成 "1"，不一致会导致随包基线与线上目录版本永远对不上。
        h.update(f"{x['id']}:{x['scale']:.2f};".encode())
    return h.hexdigest()[:12]


def get(decoration_id):
    """按 id 取挂件元数据；不存在返回 None。"""
    if not SAFE_ID.match(str(decoration_id or "")):
        return None
    if not _by_id:
        _load_manifest()
    return _by_id.get(decoration_id)


# ---------- 目录同步入库 ----------

def sync_catalog():
    """把清单同步进 decorations 表（按 id upsert，并清理清单里已删除的行）。"""
    import cm_db                                    # 延迟导入避免循环依赖
    items = _load_manifest(force=True)
    conn = cm_db.connect()
    try:
        now = int(time.time())
        conn.executemany(
            """INSERT INTO decorations(id,name,description,format,file,width,height,scale,
                                       source_url,bytes,sort,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name, description=excluded.description, format=excluded.format,
                 file=excluded.file, width=excluded.width, height=excluded.height,
                 scale=excluded.scale, source_url=excluded.source_url, bytes=excluded.bytes,
                 sort=excluded.sort, updated_at=excluded.updated_at""",
            [(x["id"], x["name"], x["description"], x["format"], x["file"], x["width"],
              x["height"], x["scale"], x["source_url"], x["bytes"], x["sort"], now)
             for x in items],
        )
        if items:
            marks = ",".join("?" * len(items))
            conn.execute(f"DELETE FROM decorations WHERE id NOT IN ({marks})",
                         [x["id"] for x in items])
        conn.commit()
        return len(items)
    finally:
        conn.close()


# ---------- 图片读取（本地 → 回源缓存） ----------

def _valid(data, item):
    """校验回源数据确实是这张图：非空 + 格式魔数 + （有 sha256 时）内容一致。"""
    if not data:
        return False
    if item["format"] in ("png", "apng") and not data.startswith(b"\x89PNG"):
        return False
    if item["format"] == "gif" and not data.startswith(b"GIF8"):
        return False
    want = item.get("sha256")
    if want and hashlib.sha256(data).hexdigest() != want:
        return False
    return True


def _fetch_remote(item):
    """按 source_url 回源抓取并缓存到 data/decorations/；失败返回 None。"""
    url = item.get("source_url")
    if not url.startswith(("http://", "https://")):
        return None
    try:
        req = urllib.request.Request(url, headers=_UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read(8 * 1024 * 1024)
    except Exception:  # noqa: BLE001  —— 网络异常一律视为不可用
        return None
    if not _valid(data, item):
        return None
    try:                                            # 缓存失败不影响本次返回
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = os.path.join(CACHE_DIR, f".{item['id']}.part")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(CACHE_DIR, item["file"]))
    except OSError:
        pass
    return data


def open_image(decoration_id):
    """取挂件图片字节。返回 (data, content_type) 或 (None, None)。"""
    item = get(decoration_id)
    if not item:
        return None, None
    for d in IMAGE_DIRS:
        fp = os.path.join(d, item["file"])
        if os.path.isfile(fp):
            try:
                with open(fp, "rb") as f:
                    return f.read(), FORMATS[item["format"]]
            except OSError:
                continue
    data = _fetch_remote(item)
    if data is None:
        return None, None
    return data, FORMATS[item["format"]]


def stats():
    """目录统计（启动日志/排查用）：清单项数 + 本地已就绪图片数。"""
    items = catalog()
    have = 0
    for x in items:
        if any(os.path.isfile(os.path.join(d, x["file"])) for d in IMAGE_DIRS):
            have += 1
    return {"total": len(items), "local": have, "dirs": IMAGE_DIRS}
