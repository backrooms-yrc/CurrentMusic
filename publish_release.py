#!/usr/bin/env python3
"""发布 APK 到服务器更新源：复制到 data/releases/ 并写 latest.json。

用法：python3 publish_release.py [apk路径] [--changelog 文本/文件] [--github-url URL]
默认取 dist/ 下版本号最大的 APK。
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
import shutil
import subprocess
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
RELEASES = os.path.join(ROOT, "data", "releases")
GH_REPO = "backrooms-yrc/CurrentMusic"


def pick_apk():
    apks = glob.glob(os.path.join(DIST, "CurrentMusic-v*.apk"))

    def key(p):
        m = re.search(r"v(\d+)\.(\d+)\.(\d+)", os.path.basename(p))
        return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)

    return max(apks, key=key) if apks else None


def apk_meta(path):
    """用 aapt 读 versionName/versionCode；缺失时退回文件名解析。"""
    name = os.path.basename(path)
    m = re.search(r"v(\d+\.\d+\.\d+)", name)
    version = m.group(1) if m else "0.0.0"
    code = 0
    aapt = os.environ.get("CM_AAPT", os.path.join(os.environ.get("ANDROID_HOME", "/opt/android-sdk"), "build-tools/34.0.0/aapt"))
    if os.path.isfile(aapt):
        try:
            out = subprocess.check_output([aapt, "dump", "badging", path], text=True, timeout=20)
            vm = re.search(r"versionName='([^']+)'", out)
            cm = re.search(r"versionCode='(\d+)'", out)
            if vm:
                version = vm.group(1)
            if cm:
                code = int(cm.group(1))
        except Exception:
            pass
    return version, code or 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("apk", nargs="?")
    ap.add_argument("--changelog", default="")
    ap.add_argument("--github-url", default="")
    args = ap.parse_args()

    apk = args.apk or pick_apk()
    if not apk or not os.path.isfile(apk):
        raise SystemExit("未找到 APK，请先执行 build.sh")
    version, code = apk_meta(apk)
    fname = os.path.basename(apk)
    os.makedirs(RELEASES, exist_ok=True)
    dst = os.path.join(RELEASES, fname)
    if os.path.abspath(apk) != os.path.abspath(dst):
        shutil.copy2(apk, dst)
    size = os.path.getsize(dst)
    h = hashlib.sha256()
    with open(dst, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    changelog = args.changelog
    if changelog == "-":
        # stdin 约定：--changelog - <<EOF …（此前未实现，'-' 原样进了 latest.json，
        # 更新弹窗因此显示不出更新内容）
        changelog = sys.stdin.read().strip()
    elif changelog and os.path.isfile(changelog):
        changelog = open(changelog, encoding="utf-8").read().strip()
    info = {
        "version": version,
        "versionCode": code,
        "fileName": fname,
        "size": size,
        "sha256": h.hexdigest(),
        "changelog": changelog,
        "publishedAt": int(time.time()),
        "githubUrl": args.github_url or f"https://github.com/{GH_REPO}/releases/download/v{version}/{fname}",
    }
    with open(os.path.join(RELEASES, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    print(f"✓ 已发布 {fname}（v{version} code={code}, {size//1024}KB）")
    print(f"  sha256 {info['sha256'][:16]}…  github 源 {info['githubUrl']}")


if __name__ == "__main__":
    main()
