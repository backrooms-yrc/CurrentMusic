#!/usr/bin/env python3
"""CurrentMusicAI 的纯逻辑测试（v1.28.51）。

只测不联网部分：卡片转文本、问题清洗、回答截断、卡片来源校验与兜底匹配。
    python3 -m unittest backend.tests.test_ai -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ai as A  # noqa: E402


class TestCardText(unittest.TestCase):
    def test_song(self):
        t = A.card_text([{"type": "song", "id": 3340114785, "name": "Reply",
                          "sub": "kz / かぐや"}])
        self.assertIn("类型：单曲", t)
        self.assertIn("名称：Reply", t)
        self.assertIn("歌手：kz / かぐや", t)
        self.assertIn("ID：3340114785", t)

    def test_playlist(self):
        t = A.card_text([{"type": "playlist", "id": 9, "name": "测试歌单", "sub": "12 首"}])
        self.assertIn("类型：歌单", t)
        self.assertIn("信息：12 首", t)

    def test_empty(self):
        self.assertEqual(A.card_text([]), "")

    def test_user_turn_optional_card(self):
        self.assertEqual(A.user_turn("", "推荐点歌"), "推荐点歌")
        self.assertIn("卡片信息", A.user_turn("类型：单曲", "背景？"))
        self.assertIn("问题：背景？", A.user_turn("类型：单曲", "背景？"))
        self.assertIn("图片", A.user_turn("", "", has_image=True))
        self.assertIn("图片", A.user_turn("", "", has_image=True))

    def test_clear_command(self):
        self.assertTrue(A.is_clear_command("清除上下文"))
        self.assertTrue(A.is_clear_command(" /reset "))
        self.assertFalse(A.is_clear_command("这首歌的背景"))


class TestCards(unittest.TestCase):
    HITS = [
        {"type": "album", "id": 1, "name": "叶惠美", "sub": "周杰伦", "pic": "a.jpg"},
        {"type": "album", "id": 2, "name": "叶惠美", "sub": "张三", "pic": "b.jpg"},
        {"type": "song", "id": 3, "name": "晴天", "sub": "Jay", "pic": "c.jpg"},
    ]

    def test_fallback_single_name(self):
        out = A._fallback_cards("推荐《晴天》，附上卡片。", [], self.HITS)
        self.assertEqual([c["id"] for c in out], [3])

    def test_fallback_ambiguous_name_needs_artist(self):
        self.assertEqual(A._fallback_cards("推荐《叶惠美》。", [], self.HITS), [])
        out = A._fallback_cards("推荐周杰伦的《叶惠美》。", [], self.HITS)
        self.assertEqual([c["id"] for c in out], [1])

    def test_fallback_does_not_duplicate_model_card(self):
        card = dict(self.HITS[2])
        out = A._fallback_cards("推荐《晴天》。", [card], self.HITS)
        self.assertEqual(len(out), 1)

    def test_attach_rejects_unknown_id(self):
        cards = []
        msg = A._attach_card({"type": "song", "id": 999, "name": "编造"}, cards, self.HITS, [])
        self.assertIn("只能附加", msg)
        self.assertEqual(cards, [])

    def test_attach_uses_source_fields_and_dedupes_name(self):
        cards = []
        msg = A._attach_card({"type": "album", "id": 1, "name": "伪造名",
                              "sub": "伪造歌手"}, cards, self.HITS, [])
        self.assertEqual(msg, "已附加")
        self.assertEqual(cards[0]["name"], "叶惠美")
        self.assertEqual(cards[0]["sub"], "周杰伦")
        msg = A._attach_card({"type": "album", "id": 2, "name": "叶惠美"}, cards, self.HITS, [])
        self.assertIn("同名", msg)
        self.assertEqual(len(cards), 1)

    def test_attach_accepts_quoted_card(self):
        cards = []
        quote = {"type": "song", "id": 77, "name": "Reply", "sub": "kz", "pic": ""}
        msg = A._attach_card({"type": "song", "id": 77}, cards, [], [quote])
        self.assertEqual(msg, "已附加")
        self.assertEqual(cards[0]["name"], "Reply")


class TestImageMessage(unittest.TestCase):
    def test_text_only_content(self):
        m = A.user_message("", "你好")
        self.assertEqual(m, {"role": "user", "content": "你好"})

    def test_multimodal_content(self):
        url = "data:image/jpeg;base64,AAAA"
        m = A.user_message("", "图里是什么？", url)
        self.assertEqual(m["role"], "user")
        self.assertIsInstance(m["content"], list)
        self.assertEqual(m["content"][0], {"type": "text", "text": "图里是什么？"})
        self.assertEqual(m["content"][1],
                         {"type": "image_url", "image_url": {"url": url}})

    def test_image_default_prompt(self):
        m = A.user_message("", "", "data:image/jpeg;base64,AAAA")
        self.assertIn("图片", m["content"][0]["text"])

    def test_image_data_url_resizes(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow 未安装")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            fp = f.name
        try:
            Image.new("RGB", (1600, 800), (200, 30, 40)).save(fp, "PNG")
            with mock.patch.object(A.cm_chat, "image_path", return_value=fp):
                url = A._image_data_url("ignored.png")
            self.assertTrue(url.startswith("data:image/jpeg;base64,"))
            import base64, io as _io
            raw = base64.b64decode(url.split(",", 1)[1])
            im = Image.open(_io.BytesIO(raw))
            self.assertLessEqual(max(im.size), A.AI_IMAGE_SIDE)
        finally:
            os.unlink(fp)

    def test_image_missing_returns_empty(self):
        self.assertEqual(A._image_data_url("does-not-exist.jpg"), "")

    def test_dsml_noise_is_removed(self):
        raw = ("<｜｜DSML｜｜ calls>\n"
               "<｜｜DSML｜｜ invoke name=\"attach_card\">\n"
               "真正的回答在这里。\n"
               "</｜｜DSML｜｜ invoke>")
        self.assertTrue(A._has_dsml(raw))
        out = A._sanitize_dsml(raw)
        self.assertEqual(out, "真正的回答在这里。")
        self.assertFalse(A._has_dsml(out))


class TestQuestionAndTrim(unittest.TestCase):
    def test_clean_question_removes_bot(self):
        self.assertEqual(A.clean_question("@CurrentMusicAI 这首歌的创作背景？"),
                         "这首歌的创作背景？")
        self.assertEqual(A.clean_question("@ CurrentMusicAI  你好"), "你好")

    def test_trim_by_sentence(self):
        text = "第一句。" * 200
        out = A.trim_answer(text, limit=50)
        self.assertLessEqual(len(out), 51)
        self.assertTrue(out.endswith("…"))
        self.assertTrue(out.startswith("第一句。"))

    def test_trim_keeps_short(self):
        self.assertEqual(A.trim_answer("短回答。"), "短回答。")


if __name__ == "__main__":
    unittest.main()
