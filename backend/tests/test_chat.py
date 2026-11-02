#!/usr/bin/env python3
"""公共聊天室纯逻辑回归测试（v1.28.30）。

不依赖网络与真实库：文本清洗、@ 提及解析、图片魔法字节嗅探、文件名白名单。
这些是「容易悄悄写错且出错后难以在真机复现」的部分（例如把控制字符放进
消息里搞乱前端渲染、或用 ../../ 穿越聊天图片目录）。

    python3 -m unittest backend.tests.test_chat -v
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_chat as C  # noqa: E402


class TestValidateContent(unittest.TestCase):
    def test_strips_and_keeps_newlines(self):
        ok, out = C.validate_content("  你好\n\n世界  ")
        self.assertTrue(ok)
        self.assertEqual(out, "你好\n\n世界")

    def test_control_chars_removed(self):
        ok, out = C.validate_content("a\x00\x1fb")
        self.assertTrue(ok)
        self.assertEqual(out, "ab")

    def test_newline_collapse(self):
        ok, out = C.validate_content("a\n\n\n\n\nb")
        self.assertEqual(out, "a\n\nb")

    def test_length_cap(self):
        ok, out = C.validate_content("字" * 800)
        self.assertEqual(len(out), C.MAX_MSG_LEN)

    def test_non_string_rejected(self):
        self.assertEqual(C.validate_content(123), (False, ""))


class TestParseMentions(unittest.TestCase):
    def test_dedupe_and_cap(self):
        ids = C.parse_mentions([3, 3, "7", 9] + list(range(20)))
        self.assertEqual(ids[0], 3)
        self.assertTrue(len(ids) <= C.MAX_MENTIONS)
        self.assertEqual(len(ids), len(set(ids)))

    def test_invalid_dropped(self):
        self.assertEqual(C.parse_mentions(["x", -1, 0, None, 5]), [5])

    def test_non_list(self):
        self.assertEqual(C.parse_mentions("3"), [])
        self.assertEqual(C.parse_mentions(None), [])


class TestParseAtts(unittest.TestCase):
    def test_valid_and_dedupe_fields(self):
        raw = [{"type": "song", "id": 123, "name": "歌", "sub": "歌手", "pic": "https://x/y.jpg"},
               {"type": "playlist", "id": 9, "name": "歌单", "sub": ""}]
        out = C.parse_atts(raw)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["id"], 123)
        self.assertEqual(out[0]["pic"], "https://x/y.jpg")
        self.assertEqual(out[1]["type"], "playlist")

    def test_invalid_items_dropped(self):
        raw = [{"type": "video", "id": 1, "name": "x"},     # 类型不在白名单
               {"type": "song", "id": 0, "name": "x"},      # id 非法
               {"type": "song", "id": 2, "name": ""},       # 名称缺失
               "garbage", None]
        self.assertEqual(C.parse_atts(raw), [])

    def test_pic_scheme_whitelist(self):
        out = C.parse_atts([{"type": "song", "id": 1, "name": "x", "pic": "javascript:alert(1)"}])
        self.assertEqual(out[0]["pic"], "")

    def test_cap_five(self):
        raw = [{"type": "song", "id": i + 1, "name": f"x{i}"} for i in range(10)]
        self.assertEqual(len(C.parse_atts(raw)), C.MAX_ATTS)

    def test_non_list(self):
        self.assertEqual(C.parse_atts("x"), [])
        self.assertEqual(C.parse_atts(None), [])


class TestLikePattern(unittest.TestCase):
    """@ 提及搜索的 LIKE 模式：通配符必须转义，否则 %/_ 会变成任意匹配。"""

    def test_plain(self):
        self.assertEqual(C.like_pattern("ℝ"), "%ℝ%")
        self.assertEqual(C.like_pattern("ℝ", prefix_only=True), "ℝ%")

    def test_wildcards_escaped(self):
        self.assertEqual(C.like_pattern("50%_"), "%50\\%\\_%")

    def test_backslash_escaped(self):
        self.assertEqual(C.like_pattern("a\\b"), "%a\\\\b%")

    def test_empty(self):
        self.assertEqual(C.like_pattern(""), "%%")


class TestImageSniff(unittest.TestCase):
    def test_magics(self):
        self.assertEqual(C.sniff_image_ext(b"\xff\xd8\xff\xe0" + b"x" * 12), "jpg")
        self.assertEqual(C.sniff_image_ext(b"\x89PNG\r\n\x1a\n" + b"x" * 8), "png")
        self.assertEqual(C.sniff_image_ext(b"GIF89a" + b"x" * 10), "gif")
        self.assertEqual(C.sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "webp")

    def test_reject_unknown(self):
        self.assertEqual(C.sniff_image_ext(b"<html>not an image"), "")
        self.assertEqual(C.sniff_image_ext(b""), "")

    def test_filename_whitelist_blocks_traversal(self):
        self.assertEqual(C.image_path("../../etc/passwd"), "")
        self.assertEqual(C.image_path("abc.JPG"), "")            # 只认小写十六进制 token
        self.assertEqual(C.image_path("0123456789abcdef.jpg"), "")   # 文件不存在也是空（但通过了正则）


if __name__ == "__main__":
    unittest.main()
