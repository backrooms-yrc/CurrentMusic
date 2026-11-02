#!/usr/bin/env python3
"""Scan tracked files (or an exported tree with --all) without printing secrets."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

SECRET_RULES = [
    (r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", "GitHub token"),
    (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "GitHub fine-grained token"),
    (r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b", "API key"),
    (r"\bcs_sk_[A-Za-z0-9]{12,}\b", "passport client secret"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key"),
    (r"\bAIza[0-9A-Za-z_-]{35}\b", "Google API key"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "Slack token"),
    (r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----", "private key"),
    (r"\bMUSIC_U\s*=\s*[A-Za-z0-9%+/_-]{24,}", "NetEase login cookie"),
    # Explicit invalid URL fixtures use user:pass or user:password.
    (r"https?://(?!user:(?:pass|password)@)[^\s/@:]+:[^\s/@]+@", "credentials in URL"),
    (r'''\bCM_(?:AI_KEY|SMTP_PASS|SMS_TOKEN|INTERNAL_PASS|LDDC_TOKEN)\s*=\s*['\"][A-Za-z0-9_+/=-]{16,}['\"]''', "literal runtime credential"),
]
SECRET_RULES = [(re.compile(pattern), label) for pattern, label in SECRET_RULES]
RUNTIME_DIRS = {"data", "backups", ".dsh", ".codex", ".ssh", "node_modules"}
PRIVATE_NOTES = {"docs/session-recovery-2026-09-30.md"}
FORBIDDEN_SUFFIXES = {".jks", ".keystore", ".p12", ".pfx", ".apk", ".aab", ".db", ".sqlite", ".sqlite3", ".msi"}


def forbidden_path(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    example = name.endswith((".example", ".sample", ".template"))
    return (name == "agents.md" or path.as_posix() in PRIVATE_NOTES
            or bool(parts & RUNTIME_DIRS) or path.suffix.lower() in FORBIDDEN_SUFFIXES
            or name.startswith(("id_rsa", "id_ed25519", "cm.db", "ncm-cookie"))
            or name.endswith((".cookie", ".secret", ".log", ".db-wal", ".db-shm"))
            or ".bak-" in name
            or ((name == ".env" or name.startswith(".env.")) and not example)
            or name in {"backend.env", "bridge.env"})


def paths(root: Path, all_files: bool):
    if not all_files:
        result = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                                stdout=subprocess.PIPE, check=True)
        yield from (Path(os.fsdecode(p)) for p in result.stdout.split(b"\0") if p)
        return
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__"}]
        for d in dirs[:]:
            p = Path(directory) / d
            if p.is_symlink():
                yield p.relative_to(root)
                dirs.remove(d)
        yield from ((Path(directory) / name).relative_to(root) for name in files)


def scan(root: Path, all_files: bool):
    findings = []
    for relative in paths(root, all_files):
        path = root / relative
        if forbidden_path(relative):
            findings.append((relative, 0, "local data, credential, binary release or private note"))
            continue
        if path.is_symlink():
            findings.append((relative, 0, "symlink; export regular source files only"))
            continue
        if not path.is_file():
            continue
        content = path.read_bytes()
        if b"\0" in content:
            continue
        for number, line in enumerate(content.decode("utf-8", errors="replace").splitlines(), 1):
            for pattern, label in SECRET_RULES:
                if pattern.search(line):
                    findings.append((relative, number, label))
                    break
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--all", action="store_true", help="scan every exported file, including hidden files")
    args = parser.parse_args()
    findings = scan(args.root.resolve(), args.all)
    for relative, line, label in findings:
        print(f"{relative}:{line}: {label}")
    print(f"Open-source scan: {len(findings)} finding(s)")
    return bool(findings)


if __name__ == "__main__":
    sys.exit(main())
