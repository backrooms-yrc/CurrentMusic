#!/usr/bin/env python3
"""一次性压缩存量头像并改成内容寻址文件名（v1.28.75 流量优化）。

做什么：
  1. 备份 originals → <avatars>/.orig-<date>/（保留旧文件兼容听歌房快照）；
  2. 每个头像等比压到 256px：无透明 → JPEG q85（文件名 {uid}-{hash}.jpg），
     有透明 → PNG（{uid}-{hash}.png）；
  3. 更新 users.avatar 为新文件名；旧文件保留不删。

用法：python3 tools/compress-avatars.py [--dry-run] [--avatars <dir>]
需要 PIL（生产环境已装；开源部署可选，跳过即可——上传路径会在有 PIL 时自动压缩）。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
import time
from io import BytesIO

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import cm_db  # noqa: E402

try:
    from PIL import Image
except Exception:
    print("缺少 PIL，无法压缩（pip install pillow 后重跑）")
    sys.exit(1)

NAME_RE = re.compile(r"^(\d+)(?:-[0-9a-f]{1,8})?\.(png|jpg|webp)$")


def shrink(path: str, max_px: int = 256):
    im = Image.open(path)
    im.load()
    if getattr(im, "n_frames", 1) > 1:
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
    if has_alpha:
        im.save(out, "PNG", optimize=True)
        ext = "png"
    else:
        im.convert("RGB").save(out, "JPEG", quality=85, optimize=True, progressive=True)
        ext = "jpg"
    return out.getvalue(), ext


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--avatars", default=os.path.join(cm_db.DATA_DIR, "avatars"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    avdir = args.avatars
    if not os.path.isdir(avdir):
        raise SystemExit(f"头像目录不存在：{avdir}")

    backup = os.path.join(avdir, f".orig-{time.strftime('%Y%m%d')}")
    files = sorted(f for f in os.listdir(avdir) if NAME_RE.match(f) and os.path.isfile(os.path.join(avdir, f)))
    before = after = 0
    renamed = {}

    for f in files:
        src = os.path.join(avdir, f)
        uid = NAME_RE.match(f).group(1)
        before += os.path.getsize(src)
        blob, ext = shrink(src)
        h = hashlib.sha1(blob).hexdigest()[:6]
        new = f"{uid}-{h}.{ext}"
        after += len(blob)
        if new == f:
            continue
        renamed[f] = new
        if args.dry_run:
            print(f"[dry] {f} ({os.path.getsize(src)//1024}KB) -> {new} ({len(blob)//1024}KB)")
            continue
        os.makedirs(backup, exist_ok=True)
        if not os.path.exists(os.path.join(backup, f)):
            shutil.copy2(src, os.path.join(backup, f))
        with open(os.path.join(avdir, new), "wb") as fh:
            fh.write(blob)

    if not args.dry_run and renamed:
        conn = cm_db.connect()
        try:
            for old, new in renamed.items():
                uid = NAME_RE.match(old).group(1)
                cur = conn.execute("SELECT avatar FROM users WHERE id=?", (int(uid),)).fetchone()
                if cur and NAME_RE.match(cur["avatar"] or "") and cur["avatar"] == old:
                    conn.execute("UPDATE users SET avatar=? WHERE id=?", (new, int(uid)))
            conn.commit()
        finally:
            conn.close()

    print(f"文件 {len(files)} 个，压缩前 {before/1048576:.1f}MB → 后 {after/1048576:.1f}MB"
          f"（{'dry-run' if args.dry_run else '已写入' + f'，备份在 {backup}' if renamed else '，无需改名'}）")
    print(f"users.avatar 更新 {len(renamed)} 条")


if __name__ == "__main__":
    main()
