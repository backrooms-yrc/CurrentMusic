#!/usr/bin/env python3
"""Compare public mirror bundles with the local deployment; never send credentials."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
ORIGINS = ('https://music.20110208.xyz', 'https://music.ctcehs.com',
           'https://currentmusic.geekertao.com', 'https://cm.bileizhen.top')


class Assets(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.files = {}
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        ref = attrs.get('src' if tag == 'script' else 'href' if tag == 'link' else '')
        if ref:
            path = urlsplit(ref).path
            match = re.search(r'(?:^|/)app(?:\.[0-9a-f]+)?\.(js|css)$', path)
            if match:
                self.files[match[1]] = ref


def fetch(url):
    result = subprocess.run(
        ['curl', '--silent', '--show-error', '--compressed', '--proto', '=https',
         '--connect-timeout', '8', '--max-time', '25', '--max-filesize', '8388608',
         '--write-out', '%{http_code}', url], capture_output=True, check=False)
    if result.returncode:
        raise ValueError(f'curl error {result.returncode}')
    body, status = result.stdout[:-3], result.stdout[-3:].decode('ascii')
    if status != '200':
        title = re.search(r'<title[^>]*>(.*?)</title>', body.decode('utf-8', 'replace'), re.S | re.I)
        detail = unescape(re.sub(r'\s+', ' ', title[1])).strip()[:120] if title else ''
        raise ValueError(f'HTTP {status}' + (f': {detail}' if detail else ''))
    return body


def check(origin, expected):
    try:
        base = origin + '/app/'
        assets = Assets(fetch(base).decode('utf-8')).files
        if set(assets) != {'js', 'css'}:
            raise ValueError('首页缺少 app.js/app.css 资源引用')
        for kind, ref in assets.items():
            url = urljoin(base, ref)
            if urlsplit(url).netloc != urlsplit(origin).netloc:
                raise ValueError('首页引用了其他站点的资源')
            if hashlib.sha256(fetch(url)).hexdigest() != expected[kind]:
                raise ValueError(f'{kind.upper()} 内容与本机部署不一致：{ref}')
        return True, f'PASS {origin}: JS/CSS 与本机部署一致'
    except (OSError, ValueError) as exc:
        return False, f'FAIL {origin}: {exc}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=ROOT / 'data/app')
    args = parser.parse_args()
    expected = {kind: hashlib.sha256((args.target / f'app.{kind}').read_bytes()).hexdigest()
                for kind in ('js', 'css')}
    with ThreadPoolExecutor(max_workers=len(ORIGINS)) as pool:
        results = list(pool.map(lambda origin: check(origin, expected), ORIGINS))
    for _, message in results:
        print(message)
    return 0 if all(ok for ok, _ in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
