#!/usr/bin/env python3
"""服务端分享图的轻量回归测试（v1.28.50 修订）。

依赖 Pillow / segno / Noto CJK 字体；缺失时整组跳过，不影响 CI。
    python3 -m unittest backend.tests.test_share_image -v
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_server
from test_password_reset import _Handler

try:
    import cm_share
    _READY = cm_share.ready()
except Exception:  # noqa: BLE001
    cm_share = None
    _READY = False


@unittest.skipUnless(_READY, "Pillow / segno / CJK 字体不可用")
class TestShareImage(unittest.TestCase):
    def test_palette_red(self):
        from PIL import Image
        hue = cm_share.palette_hue(Image.new("RGB", (40, 40), (220, 20, 20)))
        self.assertLess(min(abs(hue), abs(hue - 360)), 20)

    def test_render_without_cover(self):
        img = cm_share.render(
            {"id": 1, "name": "测试歌曲", "artists": "歌手", "album": "专辑", "pic": ""},
            "https://example.com/app/#/song/1",
        )
        self.assertEqual(img.size, (1080, 1440))

    def test_render_playlist_artist_album(self):
        cases = [
            ("playlist", "测试歌单", "Rcst20", "41 首", "ncmpl"),
            ("local-playlist", "站内歌单", "CurrentMusic 歌单", "10 首", "pl"),
            ("artist", "测试歌手", "Alias", "20 首作品 · 3 张专辑", "artist"),
            ("album", "测试专辑", "测试歌手", "2026-01-01 · 12 首", "album"),
        ]
        for kind, name, sub, sub2, path in cases:
            for style in cm_share.STYLE_VERSIONS:
                with self.subTest(kind=kind, style=style):
                    img = cm_share.render(
                        {"id": 7, "type": kind, "name": name, "sub": sub, "sub2": sub2, "pic": ""},
                        f"https://example.com/app/#/{path}/7", style,
                    )
                    self.assertEqual(img.size, (1080, 1440))

    def test_immersive_cover_reaches_edge_and_preserves_qr(self):
        from PIL import Image
        import segno

        url = "https://example.com/app/#/song/1"
        color = (224, 158, 109)
        with patch.object(cm_share, '_fetch_cover', return_value=Image.new('RGB', (750, 1000), color)):
            meta = {'name': '测试歌曲', 'artists': '歌手', 'pic': 'cover'}
            square = cm_share.render(meta, url)
            immersive = cm_share.render(meta, url, 'immersive')
        self.assertEqual(immersive.size, square.size)
        self.assertEqual(immersive.getpixel((10, 520)), color)
        self.assertNotEqual(square.getpixel((10, 520)), color)
        self.assertLess(sum(immersive.getpixel((10, 1400))), sum(color))

        modules = segno.make(url, error='m').matrix
        cell = 240 // (len(modules) + 8)
        side = cell * (len(modules) + 8)
        origin_x = 880 - side // 2 + 4 * cell
        origin_y = 1260 - side // 2 + 4 * cell
        for y, row in enumerate(modules):
            for x, bit in enumerate(row):
                pixel = immersive.getpixel((origin_x + x * cell + cell // 2, origin_y + y * cell + cell // 2))
                self.assertEqual(pixel, (17, 17, 17) if bit else (255, 255, 255))

    def test_cache_preserves_legacy_key_and_separates_styles_and_origins(self):
        meta = {'id': 1, 'name': '测试歌曲'}
        url = 'https://example.com/app/#/song/1'
        other_url = 'https://other.example.com/app/#/song/1'
        with tempfile.TemporaryDirectory() as cache, patch.object(cm_share, 'SHARE_DIR', cache):
            square = cm_share.ensure_image(meta, url)
            self.assertEqual(square, cm_share.ensure_image(meta, url, 'square'))
            key = hashlib.sha1(f'v1.28.68|{url}'.encode()).hexdigest()[:12]
            self.assertEqual(Path(square).name, f'song-1-{key}.jpg')
            immersive = cm_share.ensure_image(meta, url, 'immersive')
            self.assertNotEqual(square, immersive)
            with patch.object(cm_share, 'render', wraps=cm_share.render) as render:
                self.assertEqual(immersive, cm_share.ensure_image(meta, url, 'immersive'))
                render.assert_not_called()
                self.assertNotEqual(immersive, cm_share.ensure_image(meta, other_url, 'immersive'))
                render.assert_called_once_with(meta, other_url, 'immersive')


class TestShareImageAPI(unittest.TestCase):
    def get(self, path):
        handler = _Handler('GET', path)
        handler.headers.update({'Host': 'example.com', 'X-Forwarded-Proto': 'https'})
        cm_server.Handler._dispatch(handler, 'GET')
        return handler.status, handler.wfile.getvalue()

    def test_advertises_both_styles_and_keeps_default_url(self):
        with patch.object(cm_server, '_share_song', return_value={'name': '测试歌曲'}):
            status, raw = self.get('/share/song/1')
        self.assertEqual(status, 200)
        payload = json.loads(raw)
        image = 'https://example.com/cm/share/song/1/image'
        self.assertEqual(payload['image'], image)
        self.assertEqual(payload['images'], {
            'square': image + '?style=square', 'immersive': image + '?style=immersive',
        })

    def test_image_style_routes_and_rejects_invalid_before_fetch(self):
        path = '/share/song/1/image'
        with patch.object(cm_server, '_share_song', return_value={'name': '测试歌曲'}) as meta:
            for invalid in ('?style=', '?style=other'):
                self.assertEqual(self.get(path + invalid)[0], 400)
            meta.assert_not_called()
            with tempfile.TemporaryDirectory() as temp:
                fp = Path(temp, 'fixture.jpg')
                fp.write_bytes(b'jpeg fixture')
                with patch.object(cm_server.cm_share, 'ensure_image', return_value=fp) as ensure:
                    for query, style in (('', 'square'), ('?style=square', 'square'), ('?style=immersive', 'immersive')):
                        self.assertEqual(self.get(path + query), (200, b'jpeg fixture'))
                        self.assertEqual(ensure.call_args.args[1:], ('https://example.com/app/#/song/1', style))


if __name__ == "__main__":
    unittest.main()
