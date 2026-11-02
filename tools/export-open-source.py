#!/usr/bin/env python3
"""Export reviewed, tracked sources into the existing public repository.

Never copy a Git directory or merge private ancestry. Preview by default; --apply
copies the validated snapshot without committing or pushing it.
"""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_URL = "https://github.com/backrooms-yrc/CurrentMusic.git"
DIRECTORIES = {".github", "api-docs", "app", "assets", "backend", "decorations", "deploy", "docs", "site", "tools", "windows", "web", "licenses"}
FILES = {".gitignore", ".gitleaks.toml", "README.md", "LICENSE", "CHANGELOG.md",
         "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "SECURITY.md", "build.sh", "publish_release.py"}
EXCLUDED = {"docs/session-recovery-2026-09-30.md"}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def source_files(root):
    spec = importlib.util.spec_from_file_location("oss_scan", root / "tools/check-open-source.py")
    scanner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scanner)
    selected = []
    for raw in git(root, "ls-files", "-z").split(b"\0"):
        if not raw:
            continue
        relative = Path(raw.decode())
        if relative.as_posix() in EXCLUDED:
            continue
        if relative.parts[0] not in DIRECTORIES and relative.as_posix() not in FILES:
            raise ValueError(f"Unreviewed source path: {relative}")
        source = root / relative
        if source.is_symlink() or any(parent.is_symlink() for parent in source.parents if parent != root):
            raise ValueError(f"Symlink is not exportable: {relative}")
        if scanner.forbidden_path(relative):
            raise ValueError(f"Non-public path: {relative}")
        if source.is_file():
            selected.append(relative)
    return selected


def export(target, apply=False):
    target = target.resolve()
    if target == ROOT or ROOT in target.parents or target in ROOT.parents:
        raise ValueError("Use a separate public checkout outside the source tree")
    if not (target / ".git").is_dir():
        raise ValueError("Target must be a standalone Git checkout")
    for purpose in ((), ("--push",)):
        urls = git(target, "remote", "get-url", *purpose, "--all", "origin").decode().splitlines()
        if urls != [PUBLIC_URL]:
            raise ValueError("Unexpected public repository remote")
    if git(target, "status", "--porcelain"):
        raise ValueError("Target has uncommitted work")
    if git(target, "branch", "--show-current").strip() != b"main":
        raise ValueError("Target must be on main")
    if git(target, "rev-parse", "HEAD") != git(target, "rev-parse", "origin/main"):
        raise ValueError("Target must start at fetched origin/main")
    files = source_files(ROOT)
    if Path("LICENSE") not in files:
        raise ValueError("Missing LICENSE")
    with tempfile.TemporaryDirectory(prefix="cm-public-snapshot-") as directory:
        stage = Path(directory)
        for relative in files:
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
        subprocess.run(["python3", str(ROOT / "tools/check-open-source.py"), "--root", str(stage), "--all"], check=True)
        if apply:
            for relative in files:
                destination = target / relative
                if destination.is_symlink() or any(p.is_symlink() for p in destination.parents):
                    raise ValueError(f"Target symlink: {relative}")
            for relative in files:
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(stage / relative, destination)
    print(f"{'Exported' if apply else 'Validated'} {len(files)} files; public ancestry preserved")
    print("Existing public-only files are preserved. Review the diff and scan again before pushing.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    export(args.target, args.apply)
