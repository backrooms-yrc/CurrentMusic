#!/usr/bin/env python3
"""同步头像挂件素材到本地。

仓库内只存放 `decorations/manifest.json`（402 项元数据：名称/文件名/尺寸/大小/sha256/源地址），
图片本体不入库。本脚本按清单把图片拉到运行时目录 `data/decorations/`（data/ 已 gitignore）。

用法：
    python3 tools/sync-decorations.py              # 补全缺失（已有的按大小+sha256 校验后跳过）
    python3 tools/sync-decorations.py --check      # 只体检不下载
    python3 tools/sync-decorations.py --force      # 全部重新下载

图片缺失时后端仍可工作：/decor/<id> 会按清单里的 source_url 回源抓取并自动缓存。
"""
import argparse
import concurrent.futures as futures
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "decorations", "manifest.json")
DEST = os.path.join(ROOT, "data", "decorations")
UA = {"User-Agent": "CurrentMusic/1.0 (+avatar-decoration sync)"}
TIMEOUT = 30


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ok_on_disk(item, verify_hash=True):
    """已存在的文件是否与清单一致（先比大小，再比 sha256）。"""
    fp = os.path.join(DEST, item["file"])
    if not os.path.isfile(fp):
        return False
    if item.get("bytes") and os.path.getsize(fp) != item["bytes"]:
        return False
    if verify_hash and item.get("sha256"):
        return sha256(fp) == item["sha256"]
    return True


def download(item, force=False):
    fp = os.path.join(DEST, item["file"])
    if not force and ok_on_disk(item):
        return "skip", item["file"]
    url = item.get("source_url") or ""
    if not url.startswith(("http://", "https://")):
        return "no-url", item["file"]
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = r.read(16 * 1024 * 1024)
    except Exception as e:  # noqa: BLE001
        return f"error:{type(e).__name__}", item["file"]
    if not data:
        return "empty", item["file"]
    if item.get("sha256") and hashlib.sha256(data).hexdigest() != item["sha256"]:
        return "hash-mismatch", item["file"]
    tmp = fp + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, fp)
    return "ok", item["file"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只统计缺失，不下载")
    ap.add_argument("--force", action="store_true", help="全部重新下载")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    if not os.path.isfile(MANIFEST):
        print(f"缺少清单：{MANIFEST}", file=sys.stderr)
        return 1
    items = json.load(open(MANIFEST, encoding="utf-8"))
    os.makedirs(DEST, exist_ok=True)

    have = [x for x in items if ok_on_disk(x)]
    missing = [x for x in items if x not in have]
    print(f"清单 {len(items)} 项 | 已就绪 {len(have)} | 缺失/不一致 {len(missing)}")
    print(f"目标目录：{DEST}")
    if args.check or not missing:
        if not args.check and not missing:
            print("无需下载 ✅")
        return 0

    todo = items if args.force else missing
    tally = {}
    with futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, (status, fname) in enumerate(ex.map(lambda x: download(x, args.force), todo), 1):
            tally[status] = tally.get(status, 0) + 1
            if status != "ok" and status != "skip":
                print(f"  [{status}] {fname}", flush=True)
            if i % 50 == 0:
                print(f"  {i}/{len(todo)} …", flush=True)
    print("结果：" + " · ".join(f"{k}={v}" for k, v in sorted(tally.items())))
    bad = sum(v for k, v in tally.items() if k not in ("ok", "skip"))
    print("全部就绪 ✅" if not bad else f"仍有 {bad} 项失败（后端会在首次访问时回源重试）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
