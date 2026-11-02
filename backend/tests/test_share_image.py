#!/usr/bin/env python3
"""服务端分享图的轻量回归测试（v1.28.50 修订）。

依赖 Pillow / segno / Noto CJK 字体；缺失时整组跳过，不影响 CI。
    python3 -m unittest backend.tests.test_share_image -v
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
            with self.subTest(kind=kind):
                img = cm_share.render(
                    {"id": 7, "type": kind, "name": name, "sub": sub, "sub2": sub2, "pic": ""},
                    f"https://example.com/app/#/{path}/7",
                )
                self.assertEqual(img.size, (1080, 1440))


if __name__ == "__main__":
    unittest.main()
