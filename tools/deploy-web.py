#!/usr/bin/env python3
"""发布带文件名指纹的 Web 资源及 gzip 副本；不增加 APK 体积。"""
import argparse
import gzip
import hashlib
import os
from pathlib import Path
import re
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
    files = {p.name: p.read_bytes() for p in source.iterdir()
             if p.is_file() and p.suffix != '.gz'}
    # 部分 CDN 忽略查询串，?v= 不能区分两次构建；Web 使用真正不同的文件路径。
    # Android assets 继续使用构建时的 app.js/app.css，不重复打包这些副本。
    html = files['index.html'].decode('utf-8')
    for name in ('app.js', 'app.css'):
        asset = Path(name)
        stamp = hashlib.sha256(files[name]).hexdigest()[:16]
        fingerprinted = f'{asset.stem}.{stamp}{asset.suffix}'
        pattern = rf'''((?:src|href)=["']){re.escape(name)}(?:\?[^"']*)?(["'])'''
        html, count = re.subn(pattern, lambda m: m[1] + fingerprinted + m[2], html)
        if count != 1:
            raise ValueError(f'首页必须且只能引用一次 {name}，实际 {count} 次')
        files[fingerprinted] = files[name]
    files['index.html'] = html.encode('utf-8')
    auto_page = ROOT / 'web' / 'auto.html'
    if auto_page.is_file() and 'auto.html' not in files:
        files['auto.html'] = auto_page.read_bytes()
    names = sorted(files, key=lambda name: (name == 'index.html', name))
    # 全部先准备完，压缩失败时不动当前线上资源；首页最后切换。
    with tempfile.TemporaryDirectory(prefix='.web-stage-', dir=target) as staging:
        stage = Path(staging)
        for name in names:
            dest = stage / name
            dest.write_bytes(files[name])
            original = source / name
            if original.is_file():
                shutil.copystat(original, dest)
            if dest.suffix in ('.js', '.css', '.html', '.svg', '.json'):
                packed = stage / (name + '.gz')
                packed.write_bytes(gzip.compress(files[name], compresslevel=9, mtime=0))
                shutil.copystat(dest, packed)
        # 不删除旧的指纹文件：已打开的标签页或短暂滞后的 CDN 首页仍需加载对应资源。
        for name in names:
            packed_name = name + '.gz'
            if (stage / packed_name).exists():
                os.replace(stage / packed_name, target / packed_name)
            os.replace(stage / name, target / name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'app/src/main/assets/www')
    parser.add_argument('--target', type=Path, default=ROOT / 'data/app')
    args = parser.parse_args()
    deploy(args.source, args.target)
    print(f'Web 资源与 gzip 副本已同步：{args.target}')
