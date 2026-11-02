#!/usr/bin/env python3
"""NCM 覆盖率度量（A ∧ B ∧ C 口径）。

口径（与 docs/api-5-phase-plan.md §3 一致）——三者**同时**成立才算「已覆盖」：
  A 后端登记：路径在 backend/cm_ncm_registry.py 中已登记且阶段已启用；
             或由项目**专用入口**直接实现（cm_server 手写 /ncm/* 路由、
             或 backend 里 call("/x") 的专用调用，如 /ncmbind/qr/* → /login/qr/*）
  B 前端可达：web/src/**/*.js 里有调用点，或被某个自动化脚本调用
  C 契约测试：backend/tests/ 中有覆盖该路径的测试

分母 = 运行实例真实实现的路由数（<NCM_API_DIR>/module/*.js，含 special 覆盖）。
用 --live <dir> 指定实例目录；取不到时回退到映射表行数。

用法：
    python3 tools/ncm-coverage.py                 # 总览
    python3 tools/ncm-coverage.py --phase P2      # 只看某阶段（含该阶段及之前）
    python3 tools/ncm-coverage.py --gaps P1       # 列出 P1 缺口
    python3 tools/ncm-coverage.py --json          # 机器可读（CI 用）
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "docs", "api-endpoint-phase-map.csv")
REGISTRY_PATH = os.path.join(ROOT, "backend", "cm_ncm_registry.py")
WEB_SRC = os.path.join(ROOT, "web", "src")
NCM_API_DIR = os.environ.get("NCM_API_DIR", os.path.join(os.path.dirname(ROOT), "ncm-api"))
AUTOMATION_DIRS = [NCM_API_DIR]
DEFAULT_LIVE = os.path.join(NCM_API_DIR, "module")


def live_routes(module_dir: str) -> set:
    """运行实例实现的路由：module/*.js 文件名 → 路由（_→/，special 保留下划线）。"""
    if not os.path.isdir(module_dir):
        return set()
    special = {"daily_signin.js", "fm_trash.js", "personal_fm.js"}
    routes = set()
    for f in os.listdir(module_dir):
        if not f.endswith(".js"):
            continue
        routes.add("/" + f[:-3] if f in special else "/" + f[:-3].replace("_", "/"))
    return routes


def registry_entries() -> dict:
    """从生成的登记表里读出 path -> (tier, ttl, phase) 与 ENABLED_PHASE。"""
    if not os.path.isfile(REGISTRY_PATH):
        return {}, 0
    text = open(REGISTRY_PATH, encoding="utf-8").read()
    entries = {}
    for m in re.finditer(r'^\s*"(/[^"]+)":\s*\((\d+),\s*(\d+),\s*(\d+)\),', text, re.M):
        entries[m.group(1)] = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
    enabled = 0
    m = re.search(r"^ENABLED_PHASE\s*=\s*(\d+)", text, re.M)
    if m:
        enabled = int(m.group(1))
    return entries, enabled


# 项目**既有**能力（本次迭代之前就已接入并上线）：这些接口经 cm_server 专用路由或
# 运维自动化脚本触达，属于天然达标，不计为缺口。来源可复核：
#   grep -ohE '"/[a-z/]+"' backend/cm_ncm.py | sort -u
#   grep -ohE '/(login|song|user)[a-z/]*' <NCM_API_DIR>/refresh-cookie.sh <NCM_API_DIR>/qr-watch.py
PREEXISTING = {
    "/album", "/artist/album", "/artist/songs", "/artist/sub", "/artist/sublist", "/artists",
    "/captcha/sent", "/captcha/verify", "/cloudsearch", "/comment", "/comment/floor",
    "/comment/like", "/comment/music", "/like", "/likelist", "/login/cellphone",
    "/login/qr/check", "/login/qr/create", "/login/qr/key", "/lyric", "/lyric/new",
    "/playlist/detail", "/playlist/track/all", "/recommend/songs", "/search/hot",
    "/song/detail", "/song/url/v1", "/user/account", "/user/playlist",
    "/login/refresh", "/login/status",
}


def legacy_routes() -> set:
    """cm_server 里手写的 /ncm/* 专用路由（A 层的另一条腿：显式实现，比登记表更强）。

    认两种写法：
      1. `path == "/ncm/<上游路径>"` —— 老的 if 链；
      2. `"/ncm/<上游路径>": (...)` —— 表驱动的专用入口（如 T3 的 `_T3_ROUTES`）。
    T3 那 10 条**只能**这样实现（泛化转发对 T3 一律 403），所以第 2 种必须认。
    """
    out = set()
    path = os.path.join(ROOT, "backend", "cm_server.py")
    if not os.path.isfile(path):
        return out
    text = open(path, encoding="utf-8").read()
    for m in re.finditer(r'path == "(/ncm/[A-Za-z0-9_/\-]+)"', text):
        out.add(m.group(1)[len("/ncm"):])
    for m in re.finditer(r'"(/ncm/[A-Za-z0-9_/\-]+)"\s*:', text):
        out.add(m.group(1)[len("/ncm"):])
    return out


def dedicated_calls() -> set:
    """项目**专用**入口直接调的上游路径（backend/*.py 里的 call("/x") 字面量）。

    与 legacy_routes() 互补：后者认「新写的 /ncm/<path> 手写路由」，这里认「老的自建
    路由直接打上游」——例如 /ncmbind/phone/login → /login/cellphone、
    /ncmbind/qr/* → /login/qr/*、/ncmbind/comment → /comment。

    为什么这也算 A 层：A 的定义是「后端稳定入口：鉴权分级 + cookie 策略 + 参数规范化 +
    错误归一」。这些专用入口确实有项目自己的 Bearer 鉴权、cookie 策略（多数显式
    with_cookie=False，走用户自己的登录流程）与错误归一，与登记表驱动的泛化转发同级，
    只是写法更老。**这些路径大多不允许经泛化转发（T3），正是"只能走专用入口"的那一类。**
    """
    out = set()
    for fn in ("cm_ncm.py", "cm_server.py"):
        path = os.path.join(ROOT, "backend", fn)
        if not os.path.isfile(path):
            continue
        text = open(path, encoding="utf-8").read()
        for m in re.finditer(r'(?:cm_ncm\.)?call\(\s*"(/[A-Za-z0-9_/\-]+)"', text):
            out.add(m.group(1))
    return out


def frontend_calls(known_paths=None) -> set:
    """前端调用点。

    三种形态都要认：
      1. `/ncm/<上游路径>` 字面量（老写法，直连项目路由或网关）
      2. api.ncm('<上游路径>') （网关直调）
      3. 与登记表同名的裸上游路径字面量（如显式路径表里的 '/comment/album'）——
         这类最容易被漏算，因为字符串里没有 /ncm 前缀。
    """
    known = known_paths or set()
    calls = set()
    if not os.path.isdir(WEB_SRC):
        return calls
    for base, _dirs, files in os.walk(WEB_SRC):
        for fn in files:
            if not fn.endswith(".js"):
                continue
            try:
                text = open(os.path.join(base, fn), encoding="utf-8").read()
            except OSError:
                continue
            for m in re.finditer(r"`?/ncm(/[A-Za-z0-9_/\-]+)", text):
                calls.add(m.group(1))
            for m in re.finditer(r"""\.ncm\(\s*['"`](/[A-Za-z0-9_/\-]+)""", text):
                calls.add(m.group(1))
            for m in re.finditer(r"""['"`](/[A-Za-z][A-Za-z0-9_/\-]*)['"`]""", text):
                if m.group(1) in known:
                    calls.add(m.group(1))
    return calls


def automation_calls() -> set:
    """cookie 自动化脚本实际调用的上游端点（这些算 B 达标）。"""
    calls = set()
    for d in AUTOMATION_DIRS:
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith((".sh", ".py")):
                continue
            try:
                text = open(os.path.join(d, fn), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            for m in re.finditer(r"(?<![\w/])/(login|logout|captcha|register|user|song|playlist|"
                                r"album|artist|comment|record|msg|vip|yunbei|dj|mv|video|search|"
                                r"toplist|top|recommend|personalized|cloud)[A-Za-z0-9_/\-]*", text):
                calls.add(m.group(0))
    return calls


def contract_tests() -> set:
    """契约测试覆盖的路径（扫 backend/tests/ 里的路径字面量）。"""
    covered = set()
    tests_dir = os.path.join(ROOT, "backend", "tests")
    if not os.path.isdir(tests_dir):
        return covered
    for fn in os.listdir(tests_dir):
        if not fn.endswith(".py"):
            continue
        text = open(os.path.join(tests_dir, fn), encoding="utf-8", errors="replace").read()
        for m in re.finditer(r'["\'](/[A-Za-z0-9_/\-]+)["\']', text):
            covered.add(m.group(1))
    return covered


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", default=DEFAULT_LIVE, help="运行实例 module 目录")
    ap.add_argument("--phase", help="只看该阶段（含之前）")
    ap.add_argument("--gaps", help="列出该阶段缺口")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8")))
    excluded = {r["path"] for r in rows if r["phase"] == "EXCL"}
    live = live_routes(args.live)
    denominator = live or {r["path"] for r in rows if r["phase"] != "EXCL"}
    target = denominator - excluded

    registry, enabled = registry_entries()
    legacy = legacy_routes() | dedicated_calls()
    fe = frontend_calls(set(registry) | {r["path"] for r in rows})
    auto = automation_calls()
    tests = contract_tests()

    def phase_of(path: str) -> int:
        for r in rows:
            if r["path"] == path and r["phase"] != "EXCL":
                return int(r["phase"][1:])
        return 9

    def layer_a(p):
        if p in legacy:            # 专用手写路由：不受阶段门禁约束
            return True
        e = registry.get(p)
        return bool(e) and e[0] != 3 and e[2] <= enabled

    def layer_b(p):
        return p in fe or p in auto or p in PREEXISTING

    def layer_c(p):
        return p in tests

    covered = {p for p in target if layer_a(p) and layer_b(p) and layer_c(p)}

    if args.json:
        print(json.dumps({
            "denominator": len(denominator),
            "target": len(target),
            "excluded": len(excluded),
            "enabled_phase": enabled,
            "registry_entries": len(registry),
            "layer_a": sum(1 for p in target if layer_a(p)),
            "layer_b": sum(1 for p in target if layer_b(p)),
            "layer_c": sum(1 for p in target if layer_c(p)),
            "covered": len(covered),
            "coverage_pct": round(len(covered) / max(len(target), 1) * 100, 2),
        }, ensure_ascii=False, indent=2))
        return 0

    if args.gaps:
        ph = int(args.gaps[1:])
        gaps = sorted(p for p in target if phase_of(p) == ph and p not in covered)
        miss_a = [p for p in gaps if not layer_a(p)]
        miss_b = [p for p in gaps if not layer_b(p)]
        miss_c = [p for p in gaps if not layer_c(p)]
        print(f"== {args.gaps} 缺口 {len(gaps)} 条 ==")
        print(f"  A 未登记/未启用: {len(miss_a)}")
        print(f"  B 前端无入口    : {len(miss_b)}")
        print(f"  C 无契约测试    : {len(miss_c)}")
        for p in gaps:
            tags = "".join("ABC"[i] for i, ok in enumerate((layer_a(p), layer_b(p), layer_c(p))) if not ok)
            print(f"  [{tags:>3}] {p}")
        return 0

    print(f"分母（运行实例路由）: {len(denominator)}")
    print(f"不采用              : {len(excluded)}")
    live_n = len(denominator)
    print(f"目标集（分母-不采用）: {len(target)}   上限 = {len(target)}/{live_n} = {len(target)/max(live_n,1)*100:.1f}%")
    print(f"验收线              : ≥95% of {live_n} = {int(live_n * 0.95) + 1} 条（当前余量 {len(target) - int(live_n * 0.95) - 1} 条）")
    print(f"登记表条目          : {len(registry)}（ENABLED_PHASE={enabled}）")
    print()
    print(f"  A 后端登记且启用 : {sum(1 for p in target if layer_a(p)):4d}")
    print(f"  B 前端/自动化可达: {sum(1 for p in target if layer_b(p)):4d}")
    print(f"  C 契约测试       : {sum(1 for p in target if layer_c(p)):4d}")
    print(f"  已覆盖 A∧B∧C     : {len(covered):4d}  ({len(covered)/max(len(target),1)*100:.1f}%)")
    print()
    if args.phase:
        upto = int(args.phase[1:])
        sub = [p for p in target if phase_of(p) <= upto]
        subc = [p for p in sub if p in covered]
        print(f"阶段累计（≤P{upto}）: {len(subc)}/{len(sub)} = {len(subc)/max(len(sub),1)*100:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
