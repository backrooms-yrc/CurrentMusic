#!/usr/bin/env python3
"""生成/更新 docs/api-endpoint-phase-map.csv（阶段 → 接口 映射，事实源）。

为什么需要它：登记表（backend/cm_ncm_registry.py）与覆盖率口径都以本 CSV 为准，
若 CSV 靠临时脚本生成，阶段归属与排除清单就不可复现、也无法审查。

本脚本：
  - 从运行实例 <NCM_API_DIR>/module 取**真实路由**（文件名 _→/，special 保留）
  - 从现有 CSV 保留中文标题（缺则标「（文档未收录）」）
  - 按**显式规则**重算 phase 与 status
  - 打印统计，不隐式改动

用法：
    python3 tools/gen-endpoint-map.py --dry-run     # 只看会怎么变
    python3 tools/gen-endpoint-map.py               # 写回 CSV
"""
from __future__ import annotations

import argparse
import csv
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "docs", "api-endpoint-phase-map.csv")
MODULE_DIR = os.environ.get("NCM_MODULE_DIR", os.path.join(os.environ.get("NCM_API_DIR", os.path.join(os.path.dirname(ROOT), "ncm-api")), "module"))

TIER_HINT = "tier"  # 仅用于文档，不写回

# ---- 不采用（产品决策：能力重复或与自建体系冲突）----
NOT_ADOPTED = {
    "/listentogether/accept", "/listentogether/end", "/listentogether/heatbeat",
    "/listentogether/play/command", "/listentogether/room/check",
    "/listentogether/room/create", "/listentogether/status",
    "/listentogether/sync/list/command", "/listentogether/sync/playlist/get",
    "/decrypt", "/eapi/decrypt", "/api", "/weblog",
    "/register/checktoken/v2", "/register/checktoken/v3", "/register/xeapikey",
}

# ---- 不可达（客观限制：上游实例本身不提供该功能）----
UNREACHABLE = {
    "/chart/detail",        # 上游实测恒 502（该维度榜已下线）
    "/chart/song/detail",   # 上游实测恒 502
    # 上游实现是「占位桩」：模块源码直接 return {code:200, data:[]}，不调用任何接口。
    # 覆盖它等于调用一个空操作，无功能可覆盖。
    "/song/url/ncmget",
}

# ---- 长尾工具类（有真实能力但无独立界面场景，排到 P5 用工具箱承接）----
# 注意：**不把它们排除出分母**——它们确实是 API 支持的功能，
# 排除掉只会让覆盖率数字好看，那是自欺。改为排期到最后阶段。
LATE_TAIL = {
    "/batch",               # 批量请求包装器（需网关支持 POST）
    "/lbs/city/code",       # 行政区划数据（可用于地区选择器）
    "/search/match",        # 本地曲库匹配（安卓端可扫描本机音乐）
    "/search/multimatch",   # 多重匹配（可做搜索结果「综合」分区）
}
EXCLUDED = set(NOT_ADOPTED) | set(UNREACHABLE)


def live_routes(module_dir: str) -> list:
    if not os.path.isdir(module_dir):
        print(f"!! 找不到运行实例模块目录 {module_dir}", file=sys.stderr)
        return []
    special = {"daily_signin.js", "fm_trash.js", "personal_fm.js"}
    out = set()
    for f in os.listdir(module_dir):
        if f.endswith(".js"):
            out.add("/" + f[:-3] if f in special else "/" + f[:-3].replace("_", "/"))
    return sorted(out)


def phase_of(p: str) -> str:
    """阶段归属规则（按域归并，与 docs/api-5-phase-plan.md §5 对应）。"""
    if p in EXCLUDED:
        return "EXCL"
    if p in LATE_TAIL:
        return "P5"
    if p == "/cloudsearch":
        return "P1"
    if p.startswith(("/playlist", "/album", "/artist", "/artists", "/mv", "/video",
                     "/simi", "/mlog", "/related", "/ugc")):
        return "P3"
    if p.startswith(("/song", "/lyric", "/comment", "/cloud", "/scrobble", "/like",
                     "/likelist", "/check/music", "/audio", "/sheet", "/hug",
                     "/resource", "/share", "/music/first", "/relay", "/playmode/song")):
        return "P2"
    if p.startswith("/topic"):        # 必须在 /top 之前判定，否则被 '/top' 前缀误吞
        return "P4"
    if p.startswith(("/user", "/login", "/logout", "/register", "/captcha", "/avatar",
                     "/nickname", "/cellphone", "/rebind", "/activate", "/follow",
                     "/get/userids", "/event", "/msg", "/send", "/pl/", "/device",
                     "/setting", "/record", "/history", "/listen", "/summary",
                     "/recent", "/daily_signin", "/signin", "/sign/happy")):
        return "P4"
    if p.startswith(("/search", "/banner", "/calendar", "/homepage", "/personalized",
                     "/recommend", "/top", "/toplist", "/chart", "/style", "/batch",
                     "/countries", "/lbs")):
        return "P1"
    return "P5"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    titles, status = {}, {}
    if os.path.isfile(CSV_PATH):
        for r in csv.DictReader(open(CSV_PATH, encoding="utf-8")):
            titles[r["path"]] = r.get("title", "")
            if r.get("status"):
                status[r["path"]] = r["status"]

    routes = live_routes(MODULE_DIR)
    if not routes:
        print("无法获取运行实例路由，已中止（避免写出不完整映射）", file=sys.stderr)
        return 1

    rows = []
    for p in routes:
        ph = phase_of(p)
        # 已覆盖的判定由代码扫描决定时会更准确；此处按已知基线标注
        if p in NOT_ADOPTED:
            st = "不采用"
        elif p in UNREACHABLE:
            st = "不可达"
        else:
            st = status.get(p, "")
        rows.append({"phase": ph, "path": p, "title": titles.get(p, "（文档未收录）"),
                     "status": st})
    rows.sort(key=lambda r: (r["phase"], r["path"]))

    if args.dry_run:
        from collections import Counter
        print("阶段分布:", dict(sorted(Counter(r["phase"] for r in rows).items())))
        return 0

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["phase", "path", "title", "status"])
        w.writeheader()
        w.writerows(rows)

    from collections import Counter
    c = Counter(r["phase"] for r in rows)
    target = len(rows) - c["EXCL"]
    print(f"已写入 {CSV_PATH}")
    print(f"  运行实例路由 {len(rows)} · 不采用 {len(NOT_ADOPTED)} · 不可达/无场景 {len(UNREACHABLE)} · EXCL 合计 {c['EXCL']}")
    print(f"  可达成目标集 {target} → 95% 需 {int(target * 0.95) + 1} 条")
    print("  阶段:", dict(sorted((k, v) for k, v in c.items() if k != "EXCL")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
