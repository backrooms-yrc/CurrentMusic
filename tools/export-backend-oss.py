#!/usr/bin/env python3
"""生成仅含后端的开源快照（默认 dist/backend-oss）。

只复制可公开的代码/文档/部署模板，不复制 data、备份、APK、keystore、前端与私有站点。
生成后自动运行 tools/check-open-source.py。沿用根目录 MIT 许可证。只接受新的 dist 子目录作为输出。
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {"__pycache__", ".git"}
TRACKED = {Path(p) for p in subprocess.check_output(["git", "-C", str(ROOT), "ls-files"], text=True).splitlines()}
PUBLIC_DOCS = tuple(p.name for p in sorted(TRACKED)
                    if p.parent == Path("docs") and p.suffix == ".md"
                    and p.name != "session-recovery-2026-09-30.md")

IGNORE = """\
/AGENTS.md
.env.*
*.jks
*.keystore
data/
__pycache__/
*.py[cod]
*.log
*.db
*.sqlite*
.env
*.secret
ncm-cookie
*.apk
keystore.jks
dist/
node_modules/
"""


def copy_tree(src: Path, dst: Path) -> None:
    for p in src.rglob("*"):
        if not p.is_file() or p.is_symlink() or p.relative_to(ROOT) not in TRACKED:
            continue
        if any(part in SKIP for part in p.parts):
            continue
        if ".bak-" in p.name or p.suffix == ".pyc":
            continue
        rel = p.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dest", nargs="?", default=str(ROOT / "dist" / "backend-oss"))
    args = ap.parse_args()
    dest = Path(args.dest).resolve()
    if ROOT / "dist" not in dest.parents or dest == ROOT / "dist":
        raise SystemExit("output must be a new directory below dist/")
    if dest.exists():
        raise SystemExit("output already exists; choose a new directory")
    dest.mkdir(parents=True)

    copy_tree(ROOT / "backend", dest / "backend")
    (dest / "deploy").mkdir()
    copy_tree(ROOT / "deploy", dest / "deploy")

    (dest / "docs").mkdir()
    # 契约测试 ncm-coverage 的输入（非敏感，公开统计口径）
    csv = ROOT / "docs" / "api-endpoint-phase-map.csv"
    if csv.is_file():
        shutil.copy2(csv, dest / "docs" / csv.name)
    for name in PUBLIC_DOCS:
        p = ROOT / "docs" / name
        if p.is_file():
            shutil.copy2(p, dest / "docs" / name)

    # 后端运行需要的挂件清单（图片本体不随仓库分发）
    deco = ROOT / "decorations" / "manifest.json"
    if deco.is_file():
        (dest / "decorations").mkdir()
        shutil.copy2(deco, dest / "decorations" / "manifest.json")

    (dest / "tools").mkdir()
    for name in ("check-open-source.py", "test-lyric-merge.py", "ncm-coverage.py",
                 "export-backend-oss.py", "lddc_bridge.py", "run-tests.sh"):
        p = ROOT / "tools" / name
        if p.is_file():
            shutil.copy2(p, dest / "tools" / name)
    copy_tree(ROOT / "tools" / "lddc_headless", dest / "tools" / "lddc_headless")

    notice = ROOT / "THIRD_PARTY_NOTICES.md"
    if notice.is_file():
        shutil.copy2(notice, dest / notice.name)

    # backend/README 作为公开仓库首页；同时保留 backend/README 原位置
    readme = ROOT / "backend" / "README.md"
    if readme.is_file():
        shutil.copy2(readme, dest / "README.md")
    (dest / ".gitignore").write_text(IGNORE, encoding="utf-8")

    lic = ROOT / "LICENSE"
    if lic.is_file():
        shutil.copy2(lic, dest / "LICENSE")
        print("已复制 LICENSE")
    else:
        raise SystemExit("Missing LICENSE")

    r = subprocess.run([sys.executable, str(ROOT / "tools" / "check-open-source.py"),
                        "--root", str(dest), "--all"])
    if r.returncode != 0:
        raise SystemExit("开源扫描未通过，未生成可发布快照")
    print(f"✓ 快照已生成：{dest}")
    print("  下一步：审查 README 与依赖，然后仅在新的独立分发仓库创建初始提交（不要公开私有历史）。")


if __name__ == "__main__":
    main()
