#!/usr/bin/env python3
"""按网易云 /user/playlist 的返回顺序校准存量 NCM 歌单的 ncm_order。

背景：旧同步按“导入完成时间”排歌单，4 并发会让顺序与网易云 App「我的 → 音乐」
不一致。新同步已把上游下标写入 playlists.ncm_order；本脚本用于把历史存量一次性
校准，不需要逐个歌单重新拉 /playlist/detail。

用法：
    python3 tools/backfill-ncm-playlist-order.py            # 校准全部绑定
    python3 tools/backfill-ncm-playlist-order.py --user 107 # 只校准某个 CurrentMusic 用户
    python3 tools/backfill-ncm-playlist-order.py --dry-run

每个绑定只调用一次 /user/playlist（约 1 个请求），不改歌单曲目。
"""
from __future__ import annotations

import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import cm_db  # noqa: E402
import cm_ncm  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="校准网易云同步歌单顺序")
    ap.add_argument("--user", type=int, default=0, help="只处理这个 CurrentMusic 用户 id")
    ap.add_argument("--dry-run", action="store_true", help="只打印将写入的顺序")
    args = ap.parse_args()

    conn = cm_db.connect()
    sql = "SELECT user_id, ncm_uid FROM ncm_bindings WHERE ncm_uid>0"
    params = ()
    if args.user:
        sql += " AND user_id=?"
        params = (args.user,)
    bindings = conn.execute(sql, params).fetchall()
    conn.close()

    ok = failed = 0
    for b in bindings:
        uid, ncm_uid = int(b["user_id"]), int(b["ncm_uid"])
        binding = cm_db.get_binding(uid)
        if not binding:
            print(f"! uid={uid} 绑定缺失，跳过")
            failed += 1
            continue
        try:
            pls = cm_ncm.user_playlists(binding["cookie"], ncm_uid)
        except Exception as e:  # noqa: BLE001 单账号失败不影响其它账号
            print(f"! uid={uid} 拉取网易云歌单失败：{e}")
            failed += 1
            continue
        ids = [p["ncm_pl_id"] for p in pls]
        preview = " -> ".join(str(i) for i in ids[:8])
        print(f"uid={uid} ncm_uid={ncm_uid} playlists={len(ids)} order=[{preview}…]")
        if not args.dry_run:
            cm_db.set_ncm_playlist_orders(uid, ids)
            if ids:
                cm_db.set_binding_liked_pl(uid, ids[0])
        ok += 1

    print(f"{'dry-run ' if args.dry_run else ''}完成：成功 {ok}，失败 {failed}，{time.strftime('%Y-%m-%d %H:%M:%S')}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
