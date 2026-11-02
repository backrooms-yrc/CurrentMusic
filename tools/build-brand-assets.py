#!/usr/bin/env python3
"""Rebuild CurrentMusic branding from the approved master (requires ImageMagick)."""
from pathlib import Path
import base64
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / 'assets/brand/currentmusic-icon-master.png'


def resize(destination, size):
    destination = ROOT / destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['convert', str(MASTER), '-resize', f'{size}x{size}', '-strip', '-depth', '8',
                    '-define', 'png:compression-level=9', str(destination)], check=True)


def build():
    resize('assets/brand/currentmusic-icon.png', 512)
    resize('assets/brand/apple-touch-icon.png', 180)
    shutil.copy2(ROOT / 'assets/brand/apple-touch-icon.png', ROOT / 'site/assets/apple-touch-icon.png')
    with tempfile.TemporaryDirectory(prefix='cm-brand-') as temp:
        small = Path(temp) / 'icon.png'
        resize(small, 256)
        encoded = base64.b64encode(small.read_bytes()).decode()
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" '
               'role="img" aria-label="CurrentMusic"><title>CurrentMusic</title>'
               f'<image width="256" height="256" href="data:image/png;base64,{encoded}"/></svg>\n')
        for name in ('site/assets/favicon.svg', 'api-docs/static/img/logo.svg'):
            (ROOT / name).write_text(svg)
    cover = ROOT / 'site/assets/og-cover.svg'
    text = re.sub(r'(<image id="cm-brand-icon"[^>]+href=")[^"]*("/>)',
                  lambda m: m[1] + 'data:image/png;base64,' + encoded + m[2], cover.read_text())
    cover.write_text(text)
    with tempfile.TemporaryDirectory(prefix='cm-brand-cover-') as temp:
        png = Path(temp) / 'cover.png'
        subprocess.run(['rsvg-convert', str(cover), '-o', str(png)], check=True)
        subprocess.run(['convert', str(png), '-quality', '90', str(cover.with_suffix('.jpg'))], check=True)
    for density, size in (('mdpi',48), ('hdpi',72), ('xhdpi',96), ('xxhdpi',144), ('xxxhdpi',192)):
        resize(f'app/src/main/res/mipmap-{density}/ic_launcher.png', size)
    resize('app/src/main/res/drawable-nodpi/ic_launcher_foreground.png', 432)
    for name in ('brand-icon.png', 'apple-touch-icon.png'):
        source = ROOT / ('assets/brand/currentmusic-icon.png' if name == 'brand-icon.png' else 'assets/brand/apple-touch-icon.png')
        shutil.copy2(source, ROOT / 'app/src/main/assets/www' / name)
    print('Brand assets rebuilt: Web, website, docs, and Android launcher.')


if __name__ == '__main__':
    build()
