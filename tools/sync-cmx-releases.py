#!/usr/bin/env python3
"""把 CurrentMusicX 的 GitHub Releases 镜像到本机，供 /cm/x/download/latest 直链使用。

解决什么
--------
`https://music.20110208.xyz/cm/x/download/latest` 必须**永远直接吐出最新安装包**，
而 GitHub Releases 在国内直连慢、易断。本脚本把上游最新的 APK 抓到本机
`data/releases-x/`，并写一份 `latest.json` 供后端读取：

    https://music.20110208.xyz/cm/x/download/latest           → 直链（200，APK 本体）
    https://music.20110208.xyz/cm/x/download/<file>.apk       → 指定版本直链
    https://music.20110208.xyz/cm/x/version/latest            → 版本元数据 JSON

由 `currentmusic-x-sync.timer` 每 3 分钟调用一次，因此上游发版后延迟上限
约 3 分钟（含下载 40MB 的时间）。

设计要点
--------
* 只用一个请求：`GET /repos/{repo}/releases?per_page=N` 同时拿到最新版与历史，
  比 `releases/latest` + 列表两次请求省一半配额。
* `ETag` 条件请求：内容没变时上游回 304，**304 不计入 GitHub 速率限制**
  （匿名 60 次/小时）。20 次/小时的轮询因此几乎不可能被限流。
* 幂等：本地文件大小与上游一致就跳过下载，绝不重复拉 40MB。
* 原子：先写 `.part` 再 `os.replace`，后端读到的永远是完整文件。
* 校验：下载后校验体积、`PK` 魔数与 sha256，任一不符即丢弃，避免把
  GitHub 的错误页当成 APK 缓存下来。
* 保留最近 `--keep` 个版本（默认 2，约 80MB），更早的自动清理。

用法
----
    python3 tools/sync-cmx-releases.py            # 正常同步（幂等）
    python3 tools/sync-cmx-releases.py --force     # 忽略 ETag，强制核对
    python3 tools/sync-cmx-releases.py --dry-run   # 只报告，不落盘
    python3 tools/sync-cmx-releases.py --keep 5    # 保留 5 个历史 APK

环境变量：`CM_GITHUB_TOKEN` / `GITHUB_TOKEN`（可选，提高速率上限）、
`CM_X_RELEASES`（镜像目录，默认 `<repo>/data/releases-x`）。
"""

from __future__ import annotations

import argparse
import calendar
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.environ.get("CM_X_REPO", "bileizhen/CurrentMusicX")
OUT_DIR = os.environ.get("CM_X_RELEASES", os.path.join(ROOT, "data", "releases-x"))
LATEST = os.path.join(OUT_DIR, "latest.json")
STATE = os.path.join(OUT_DIR, "sync-state.json")
UA = "CurrentMusicX-Mirror/1.0 (+https://music.20110208.xyz/cm/x/download/latest)"
API = f"https://api.github.com/repos/{REPO}/releases"
AAPT = os.environ.get("CM_AAPT", "/opt/android-sdk/build-tools/34.0.0/aapt")
TIMEOUT = 30
DL_TIMEOUT = 300
RETRIES = 3
LIST_COUNT = 20          # 一次拉取用于「最新 + 历史」的发布条数


# ── 日志 ──────────────────────────────────────────────────────────────────
def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] ! {msg}", file=sys.stderr, flush=True)


# ── HTTP ──────────────────────────────────────────────────────────────────
def _headers(extra: dict | None = None) -> dict:
    h = {
        "User-Agent": UA,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("CM_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        h["Authorization"] = f"Bearer {token}"
    if extra:
        h.update(extra)
    return h


class HttpResult:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status: int, headers, body: bytes):
        self.status, self.headers, self.body = status, headers, body


def http_get(url: str, extra_headers: dict | None = None, timeout: int = TIMEOUT) -> HttpResult:
    """带重试的 GET；304 与 404 直接返回，其余错误抛异常。"""
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=_headers(extra_headers))
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return HttpResult(r.status, r.headers, r.read())
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:  # noqa: BLE001
                pass
            if e.code == 304:
                return HttpResult(304, e.headers, b"")
            if e.code == 404:
                return HttpResult(404, e.headers, body)
            if e.code in (403, 429):
                # 速率限制：把剩余额度带出来，便于运维判断
                raise RuntimeError(
                    f"GitHub 拒绝请求 {e.code}（剩余额度 {e.headers.get('X-RateLimit-Remaining')}，"
                    f"重置 {e.headers.get('X-RateLimit-Reset')}）："
                    f"{body[:200].decode('utf-8', 'replace')}") from e
            last = e
        except Exception as e:  # noqa: BLE001  (网络抖动 / DNS / 超时)
            last = e
        if attempt < RETRIES:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"请求失败（重试 {RETRIES} 次）：{url} —— {last}")


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: str, expect_size: int | None = None,
             magic: bytes | None = None) -> tuple[int, str]:
    """流式下载到 `dest.part`，校验后原子改名为 `dest`。返回 (size, sha256)。

    `magic` 为期望的文件头（APK 传 `b"PK"`）：防住把 GitHub 的错误页/限流页
    当成安装包缓存下来——这类错误页 HTTP 200、体积也不小，只靠体积判断不住。
    """
    part = dest + ".part"
    if os.path.exists(part):
        os.remove(part)
    h = hashlib.sha256()
    got = 0
    req = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=DL_TIMEOUT) as r, open(part, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                h.update(chunk)
                got += len(chunk)
        if expect_size and got != expect_size:
            raise RuntimeError(f"体积不符：期望 {expect_size} 实得 {got}")
        if magic:
            with open(part, "rb") as f:
                head = f.read(len(magic))
            if head != magic:
                raise RuntimeError(f"文件头不符（期望 {magic!r}，实得 {head!r}）")
    except BaseException:
        if os.path.exists(part):
            os.remove(part)
        raise
    os.replace(part, dest)
    return got, h.hexdigest()


# ── JSON 存取 ─────────────────────────────────────────────────────────────
def load_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_json(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # mkstemp 默认 0600；元数据要让 nginx/其它进程也能读，显式放宽到 0644
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# ── 上游数据整形 ──────────────────────────────────────────────────────────
def version_of(tag: str) -> str:
    return (tag or "").lstrip("vV").strip()


def pick_apk(rel: dict) -> dict | None:
    apks = [a for a in (rel.get("assets") or []) if a["name"].lower().endswith(".apk")]
    if not apks:
        return None
    # 同一发布里若挂了多个 APK（分架构/渠道），取名字最短的那个：
    # 上游惯例是主包叫 CurrentMusic-Android-vX.Y.Z.apk。
    return sorted(apks, key=lambda a: (len(a["name"]), a["name"]))[0]


def rel_summary(rel: dict) -> dict:
    apk = pick_apk(rel)
    return {
        "tag": rel.get("tag_name") or "",
        "version": version_of(rel.get("tag_name") or ""),
        "name": rel.get("name") or rel.get("tag_name") or "",
        "publishedAt": rel.get("published_at") or rel.get("created_at") or "",
        "htmlUrl": rel.get("html_url") or "",
        "apkName": (apk or {}).get("name") or "",
        "apkSize": (apk or {}).get("size") or 0,
        "apkUrl": (apk or {}).get("browser_download_url") or "",
        "apkDownloads": (apk or {}).get("download_count") or 0,
    }


def apk_meta(path: str) -> dict:
    """从本地 APK 读 versionCode / minSdk / targetSdk / packageName。

    这些字段 GitHub Release 元数据里没有，但管理台「客户端」页要展示；
    aapt 只在镜像 APK 已落盘时跑一次（同步脚本每 3 分钟一次，aapt 读 116MB
    安装包约几百毫秒，不会成为瓶颈）。没有 Android SDK 的部署自然留空。
    """
    if not path or not os.path.isfile(path):
        return {}
    aapt = AAPT if os.path.isfile(AAPT) else (shutil.which("aapt") or "")
    if not aapt:
        return {}
    try:
        out = subprocess.check_output(
            [aapt, "dump", "badging", path],
            text=True, stderr=subprocess.DEVNULL, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    meta = {}
    m = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'", out)
    if m:
        meta["packageName"] = m.group(1)
        meta["versionCode"] = int(m.group(2))
        meta["versionName"] = m.group(3)
    m = re.search(r"^sdkVersion:'(\d+)'", out, re.M)
    if m:
        meta["minSdk"] = int(m.group(1))
    m = re.search(r"^targetSdkVersion:'(\d+)'", out, re.M)
    if m:
        meta["targetSdk"] = int(m.group(1))
    return meta


def iso_to_ts(iso: str) -> int:
    """GitHub 的 `2026-10-13T13:02:26Z` → unix 秒（UTC，与后端别处一致）。"""
    if not iso:
        return 0
    try:
        return calendar.timegm(time.strptime(iso.replace("Z", ""), "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return 0


# ── 主流程 ────────────────────────────────────────────────────────────────
def prune(keep: set[str], dry: bool) -> list[str]:
    """删掉不在保留集里的历史 APK；只动本目录下的 .apk，且必须是本脚本下过的。"""
    state = load_json(STATE)
    mirrored = set(state.get("mirrored") or [])
    removed = []
    for name in sorted(mirrored - keep):
        base = os.path.basename(name)
        if base != name or not base.endswith(".apk"):
            continue
        path = os.path.join(OUT_DIR, base)
        if os.path.isfile(path):
            removed.append(base)
            if not dry:
                os.remove(path)
                mirrored.discard(name)
    if removed and not dry:
        state["mirrored"] = sorted(mirrored)
        save_json(STATE, state)
    return removed


def main() -> int:
    ap = argparse.ArgumentParser(description="镜像 CurrentMusicX 的 GitHub Releases")
    ap.add_argument("--force", action="store_true", help="忽略 ETag，强制向上游核对")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    ap.add_argument("--keep", type=int, default=2, help="保留的历史 APK 个数（默认 2）")
    ap.add_argument("--quiet", action="store_true", help="没有变化时不打印")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    # 单实例：定时器与手工执行撞车时，后来者直接退出，避免两个进程抢同一个 .part
    lock_path = os.path.join(OUT_DIR, ".lock")
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("已有同步任务在跑，本次跳过")
        return 0

    state = load_json(STATE)
    cur = load_json(LATEST)

    etag = state.get("etag") or ""
    extra = {} if (args.force or not etag) else {"If-None-Match": etag}
    if not args.quiet:
        log(f"核对上游 {REPO} …")
    res = http_get(f"{API}?per_page={LIST_COUNT}", extra)
    if res.status == 304:
        state["lastChecked"] = int(time.time())
        if not args.dry_run:
            save_json(STATE, state)
        if not args.quiet:
            log(f"上游无变化（当前 v{cur.get('version', '?')}，304 不计入速率限制）")
        return 0
    if res.status == 404:
        warn(f"仓库不存在或不可访问：{REPO}")
        return 2

    releases = json.loads(res.body.decode("utf-8"))
    if not isinstance(releases, list):
        warn(f"上游返回了非预期结构：{str(releases)[:200]}")
        return 3
    stable = [r for r in releases if not r.get("draft") and not r.get("prerelease")]
    if not stable:
        warn("上游没有可用的正式版（全部为草稿/预发布）")
        return 4

    latest = stable[0]
    tag = latest.get("tag_name") or ""
    apk = pick_apk(latest)
    if not apk:
        warn(f"{tag} 没有 APK 附件，保持现有镜像不动")
        return 5

    state["etag"] = res.headers.get("ETag") or etag
    state["lastChecked"] = int(time.time())
    state["repo"] = REPO

    # ── 1. APK ───────────────────────────────────────────────────────────
    fname = apk["name"]
    dest = os.path.join(OUT_DIR, fname)
    size = apk.get("size") or 0
    changed = cur.get("tag") != tag
    already = os.path.isfile(dest) and (not size or os.path.getsize(dest) == size)
    if already:
        digest = cur.get("apk", {}).get("sha256") if cur.get("tag") == tag else ""
        if not digest:
            digest = sha256_of(dest)
        log(f"APK 已在本地：{fname}（{size / 1048576:.1f} MB，跳过下载）")
    elif args.dry_run:
        digest = ""
        log(f"[dry-run] 需要下载：{fname}（{size / 1048576:.1f} MB）")
    else:
        t0 = time.time()
        log(f"下载 {fname}（{size / 1048576:.1f} MB）…")
        got, digest = download(apk["browser_download_url"], dest, size, magic=b"PK")
        log(f"完成 {got / 1048576:.1f} MB / {time.time() - t0:.1f}s  sha256 {digest[:16]}…")

    mirrored = set(state.get("mirrored") or [])
    if os.path.isfile(dest):
        mirrored.add(fname)

    # ── 2. 元数据 ────────────────────────────────────────────────────────
    history = [rel_summary(r) for r in stable[:LIST_COUNT]]
    for h in history:
        h["mirrored"] = bool(h["apkName"]) and os.path.isfile(os.path.join(OUT_DIR, h["apkName"]))
    keep_tags = [h["tag"] for h in history[: max(1, args.keep)]]
    keep_files = {h["apkName"] for h in history if h["tag"] in keep_tags and h["apkName"]}

    apk_info = {
        "fileName": fname,
        "size": size or (os.path.getsize(dest) if os.path.isfile(dest) else 0),
        "sha256": digest,
        "githubUrl": apk["browser_download_url"],
        "downloads": apk.get("download_count") or 0,
        "mirrored": os.path.isfile(dest),
    }
    apk_info.update(apk_meta(dest))
    info = {
        "repo": REPO,
        "repoUrl": f"https://github.com/{REPO}",
        "releasesUrl": f"https://github.com/{REPO}/releases",
        "tag": tag,
        "version": version_of(tag),
        "name": latest.get("name") or tag,
        "body": latest.get("body") or "",
        "publishedAt": iso_to_ts(latest.get("published_at") or ""),
        "publishedAtIso": latest.get("published_at") or "",
        "htmlUrl": latest.get("html_url") or "",
        "apk": apk_info,
        "history": history,
        "syncedAt": int(time.time()),
        "keep": max(1, args.keep),
    }

    if args.dry_run:
        log(f"[dry-run] 将写入 {LATEST}（tag={tag}）")
        return 0

    save_json(LATEST, info)
    state["mirrored"] = sorted(mirrored)
    state["lastSuccess"] = int(time.time())
    save_json(STATE, state)

    gone = prune(keep_files, args.dry_run)
    if gone:
        log(f"清理旧安装包：{', '.join(gone)}（保留最近 {max(1, args.keep)} 个版本）")

    if changed:
        log(f"✓ 发现新版本 v{info['version']}（{fname}，{info['apk']['size'] / 1048576:.1f} MB）")
    else:
        log(f"✓ 已是最新 v{info['version']}，元数据已刷新")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:  # noqa: BLE001
        warn(f"同步失败：{e}")
        sys.exit(1)
