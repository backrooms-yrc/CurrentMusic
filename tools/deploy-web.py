#!/usr/bin/env python3
"""原子同步 Web 资源并生成 gzip 预压缩文件；不将压缩副本放入 APK。"""
import argparse
import gzip
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def deploy(source, target):
    source, target = Path(source), Path(target)
    required = ("app.js", "app.css", "index.html")
    for name in required:
        if not (source / name).is_file() or not (source / name).stat().st_size:
            raise ValueError(f"构建产物缺失或为空：{source / name}")
    if source.resolve() == target.resolve():
        raise ValueError("源目录与发布目录不能相同")
    target.mkdir(parents=True, exist_ok=True)
    files = sorted((p for p in source.iterdir() if p.is_file() and p.suffix != '.gz'),
                   key=lambda p: (p.name == 'index.html', p.name))
    auto_page = ROOT / 'web' / 'auto.html'
    if auto_page.is_file() and not any(p.name == 'auto.html' for p in files):
        files.insert(0, auto_page)
    # 全部先准备完，压缩失败时不动当前线上资源；首页最后切换。
    with tempfile.TemporaryDirectory(prefix='.web-stage-', dir=target) as staging:
        stage = Path(staging)
        for src in files:
            shutil.copy2(src, stage / src.name)
            if src.suffix in ('.js', '.css', '.html', '.svg', '.json'):
                packed = stage / (src.name + '.gz')
                packed.write_bytes(gzip.compress(src.read_bytes(), compresslevel=9, mtime=0))
                shutil.copystat(src, packed)
        for src in files:
            packed_name = src.name + '.gz'
            if (stage / packed_name).exists():
                os.replace(stage / packed_name, target / packed_name)
            os.replace(stage / src.name, target / src.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'app/src/main/assets/www')
    parser.add_argument('--target', type=Path, default=ROOT / 'data/app')
    args = parser.parse_args()
    deploy(args.source, args.target)
    print(f'Web 资源与 gzip 副本已同步：{args.target}')
