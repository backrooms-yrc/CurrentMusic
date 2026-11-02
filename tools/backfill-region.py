#!/usr/bin/env python3
"""按访问日志回填用户的 IP 属地（一次性/可重跑）。

问题：IP 属地是在「登录/鉴权请求」时才采集的，上线前的老用户在下一次活跃前
都没有属地。而 nginx 的 `POST /cm/plays/<歌曲id>` 日志里有 IP，播放表里有
「用户 + 歌曲 + 时间」，两边可以精确对上。

匹配规则（宁缺毋滥，**歧义一律跳过**）：
  1. 取 `POST /cm/plays/<ncm_id>` 的日志行，键 = (ncm_id, 秒级时间, IP)；
     只有「同一键下唯一 IP」的才参与匹配；
  2. 播放表里同一 (ncm_id, played_at) 若对应多个用户 → 跳过（无法确定是谁）；
  3. 同一用户匹配到多个 IP 时取出现次数最多的那个（移动网络换 IP 很常见）。

用法：
    python3 tools/backfill-region.py [--log /www/wwwlogs/music.20110208.xyz.log] [--dry]
    python3 tools/backfill-region.py --dry          # 只统计，不写库
"""
from __future__ import annotations

import argparse
import collections
import datetime
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import ipaddress     # noqa: E402

import cm_db          # noqa: E402
import cm_region as R  # noqa: E402

# 代理/CDN 段：历史上启用 Cloudflare 期间的日志会是 CF 边缘 IP，不能当成用户属地
_PROXY_NETS = tuple(ipaddress.ip_network(n) for n in (
    "104.16.0.0/12", "172.64.0.0/13", "162.158.0.0/15", "188.114.96.0/20",
    "198.41.128.0/17", "173.245.48.0/20", "197.234.240.0/22",
    "108.162.192.0/18", "141.101.64.0/18", "190.93.240.0/20",
))


def is_proxy_ip(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return any(a in n for n in _PROXY_NETS)

DEFAULT_LOG = "/www/wwwlogs/music.20110208.xyz.log"
LINE_RE = re.compile(
    r'^(?P<ip>[\d.]+|-)\s+-\s+-\s+\[(?P<ts>[^\]]+)\]\s+"POST /cm/plays/(?P<nid>\d+)\s+HTTP/')


def log_ips(path):
    """(ncm_id, 秒级时间) -> 唯一 IP；同一键多 IP 的丢弃（歧义）。"""
    seen = collections.defaultdict(set)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if "/cm/plays/" not in line:
                continue
            m = LINE_RE.match(line)
            if not m:
                continue
            ip = m.group("ip")
            if ip == "-":
                continue
            ts = m.group("ts").split()[0]            # 17/Oct/2026:15:37:10
            seen[(int(m.group("nid")), ts)].add(ip)
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1}


def local_stamp(unix_ts):
    """与 nginx $time_local 对齐（服务器本地时区）。"""
    return datetime.datetime.fromtimestamp(int(unix_ts)).strftime("%d/%b/%Y:%H:%M:%S")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--dry", action="store_true", help="只统计匹配，不写库")
    ap.add_argument("--limit", type=int, default=200, help="最多回填多少用户")
    args = ap.parse_args()

    if not os.path.isfile(args.log):
        print(f"日志不存在：{args.log}")
        return 1

    print(f"解析日志 {args.log} …")
    ip_map = log_ips(args.log)
    print(f"可用的 (歌曲, 秒) → IP 条目：{len(ip_map)}")

    conn = cm_db.connect()
    try:
        rows = conn.execute(
            """SELECT p.user_id, p.ncm_id, p.played_at, u.ip_region
               FROM plays p JOIN users u ON u.id=p.user_id
               WHERE u.username!='__internal__' AND u.disabled=0
               ORDER BY p.played_at DESC""").fetchall()
    finally:
        conn.close()

    # 同一 (歌曲, 秒) 对应多个用户 → 无法确定，整键跳过
    key_users = collections.defaultdict(set)
    for r in rows:
        key_users[(int(r["ncm_id"]), local_stamp(r["played_at"]))].add(int(r["user_id"]))
    ambiguous = {k for k, us in key_users.items() if len(us) > 1}

    hits = collections.defaultdict(list)                  # uid -> [(played_at, ip)]
    need = set()
    for r in rows:
        uid = int(r["user_id"])
        if r["ip_region"]:
            continue
        key = (int(r["ncm_id"]), local_stamp(r["played_at"]))
        if key in ambiguous or key not in ip_map:
            continue
        ip = ip_map[key]
        if is_proxy_ip(ip):
            continue
        hits[uid].append((int(r["played_at"]), ip))
        need.add(uid)

    print(f"可回填用户：{len(need)}（歧义跳过 {len(ambiguous)} 个键）")
    todo = sorted(need)[: args.limit]
    done = failed = 0
    for i, uid in enumerate(todo, 1):
        ip = max(hits[uid])[1]                           # 最近一次播放的 IP（属地以最新为准）
        prefix = R.prefix_of(ip)
        region = R._cached(prefix) if prefix else ""
        if not region and prefix:
            region = R._lookup(ip)
            time.sleep(1.7)                              # 与线上队列同速，避开免费额度
        if not region:
            failed += 1
            print(f"  [{i}/{len(todo)}] uid={uid} ip={ip} → 解析失败")
            continue
        if prefix:
            R._remember(prefix, region)
        if not args.dry:
            cm_db.set_user_region(uid, region)
        done += 1
        print(f"  [{i}/{len(todo)}] uid={uid} ip={ip} → {region}")
    print(f"完成：成功 {done}，失败 {failed}，{'仅统计未写库' if args.dry else '已写库'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
