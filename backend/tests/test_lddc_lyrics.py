#!/usr/bin/env python3
"""LDDC provider 的纯逻辑回归：归一化、质量门槛、网易云辅助轨合并。"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_lddc as L  # noqa: E402


def word(t, text, end=None):
    return {"start": t, "end": t + (end or 200), "text": text}


def line(t, text, words=None, end=None):
    return {"start": t, "end": end or t + 2000, "words": words or [word(t, text)]}


def payload(orig, ts=None, roma=None):
    return {"orig": orig, "ts": ts or [], "roma": roma or [], "source": "lddc:KG"}


class TestNormalizeProvider(unittest.TestCase):
    def test_drops_kugou_header_and_builds_words(self):
        data = payload(
            orig=[
                line(0, "晴天 - 周杰伦 (Jay Chou)", [
                    word(0, "晴天 - ", 800), word(800, "周杰伦", 600),
                    word(1400, " (Jay Chou)", 600),
                ], end=2000),
                line(2000, "词：周杰伦", [word(2000, "词", 200), word(2200, "：周杰伦", 400)]),
                line(3000, "故事的小黄花", [word(3000, "故", 200), word(3200, "事", 200),
                                            word(3400, "的", 200), word(3600, "小黄花", 600)]),
                line(5000, "从出生那年就飘着", [word(5000, "从", 200), word(5200, "出生那年就飘着", 800)]),
            ],
            ts=[line(3000, "The little yellow flower"), line(5000, "Drifting since the year I was born")],
        )
        out = L.normalize_provider_lyrics(data, {"title": "晴天", "artists": ["周杰伦"]})
        self.assertIsNotNone(out)
        self.assertTrue(out["wordLevel"])
        self.assertEqual(out["source"], "lddc:kg")
        self.assertEqual(len(out["lines"]), 3)
        self.assertEqual(out["lines"][0]["txt"], "词：周杰伦")
        self.assertEqual(out["lines"][1]["trans"], "The little yellow flower")
        self.assertEqual(out["lines"][1]["w"][0][0], 3000)
        self.assertEqual("".join(x[1] for x in out["lines"][1]["w"]), "故事的小黄花")
        self.assertEqual(len(out["lines"][1]["words"]), 4)

    def test_rejects_line_level_without_allow_line(self):
        data = payload(orig=[line(0, "第一行"), line(2000, "第二行")])
        self.assertIsNone(L.normalize_provider_lyrics(data, {"title": "x", "artists": []}))
        out = L.normalize_provider_lyrics(data, {"title": "x", "artists": []}, allow_line=True)
        self.assertIsNotNone(out)
        self.assertFalse(out["wordLevel"])
        self.assertEqual(len(out["lines"]), 2)

    def test_rejects_too_few_or_untimed_lines(self):
        self.assertIsNone(L.normalize_provider_lyrics(
            payload(orig=[line(0, "only")]), {"title": "x", "artists": []}, allow_line=True))
        self.assertIsNone(L.normalize_provider_lyrics(
            payload(orig=[{"start": None, "words": [word(0, "a")]}, line(1, "b")]),
            {"title": "x", "artists": []}, allow_line=True))

    def test_bridge_output_is_validated(self):
        data = {
            "source": "lddc:kg",
            "wordLevel": True,
            "lines": [
                {"t": 0, "txt": "abc", "trans": "", "roma": "",
                 "w": [[0, "a"], [100, "bc"]],
                 "words": [{"start": 0, "end": 100, "text": "a"},
                           {"start": 100, "end": 300, "text": "bc"}]},
                {"t": 500, "txt": "def", "trans": "译", "roma": "",
                 "w": [[500, "d"], [600, "ef"]]},
            ],
        }
        out = L.normalize_provider_lyrics(data, {"title": "x", "artists": []})
        self.assertIsNotNone(out)
        self.assertEqual(len(out["lines"]), 2)
        # 第二条没有 words，ensure_words 会按 w 补出结束时间
        self.assertEqual(out["lines"][1]["words"][0]["text"], "d")
        self.assertEqual(out["lines"][1]["words"][1]["end"], 1800)

    def test_bad_w_is_dropped_not_trusted(self):
        data = {
            "source": "lddc:kg",
            "lines": [
                {"t": 0, "txt": "abc", "w": [[0, "xxx"], [100, "yyy"]]},
                {"t": 500, "txt": "def", "w": [[500, "d"], [600, "ef"]]},
            ],
        }
        out = L.normalize_provider_lyrics(data, {"title": "x", "artists": []}, allow_line=True)
        self.assertIsNotNone(out)
        self.assertNotIn("w", out["lines"][0])
        self.assertIn("w", out["lines"][1])
        self.assertFalse(out["wordLevel"])


class TestMerge(unittest.TestCase):
    def setUp(self):
        self.base = {
            "isYrc": False,
            "source": "ncm:lrc",
            "lines": [
                {"t": 1000, "txt": "春の風", "trans": "春风", "roma": "haru no kaze",
                 "w": [[1000, "春"], [1200, "の"], [1400, "風"]], "wSynth": True},
                {"t": 3000, "txt": "君を想う", "trans": "想你", "roma": "kimi o omou",
                 "w": [[3000, "君"], [3300, "を"], [3500, "想う"]], "wSynth": True},
            ],
        }

    def test_lddc_timing_wins_and_ncm_translation_fills_gaps(self):
        ext = {
            "source": "lddc:kg",
            "wordLevel": True,
            "lines": [
                {"t": 1000, "txt": "春の風", "trans": "", "roma": "",
                 "w": [[1000, "春"], [1100, "の"], [1250, "風"]],
                 "words": [{"start": 1000, "end": 1100, "text": "春"},
                           {"start": 1100, "end": 1250, "text": "の"},
                           {"start": 1250, "end": 1900, "text": "風"}]},
                {"t": 3000, "txt": "君を想う", "trans": "", "roma": "",
                 "w": [[3000, "君"], [3200, "を"], [3600, "想う"]]},
            ],
        }
        out = L.merge_with_base(self.base, ext)
        self.assertEqual(out["source"], "lddc:kg")
        self.assertEqual(out["lines"][0]["w"], ext["lines"][0]["w"])
        self.assertNotIn("wSynth", out["lines"][0])
        self.assertEqual(out["lines"][0]["trans"], "春风")
        self.assertEqual(out["lines"][0]["roma"], "haru no kaze")
        self.assertIn("words", out["lines"][1])

    def test_line_level_lddc_borrows_synth_axis_and_marks_it(self):
        ext = {
            "source": "lddc:kg",
            "wordLevel": False,
            "lines": [
                {"t": 1000, "txt": "春の風", "trans": "LDDC 翻译", "roma": ""},
                {"t": 3000, "txt": "君を想う", "trans": "", "roma": ""},
            ],
        }
        out = L.merge_with_base(self.base, ext)
        self.assertTrue(out["lines"][0]["trans"] == "LDDC 翻译")
        self.assertEqual(out["lines"][0]["w"], self.base["lines"][0]["w"])
        self.assertTrue(out["lines"][0]["wSynth"])
        self.assertEqual(out["lines"][1]["trans"], "想你")

    def test_empty_external_is_ignored(self):
        self.assertIsNone(L.merge_with_base(self.base, None))
        self.assertIsNone(L.merge_with_base(self.base, {"lines": []}))


class TestCacheTtl(unittest.TestCase):
    def test_official_and_lddc_cache_longer(self):
        with mock.patch.object(L, "LDDC_URL", "http://127.0.0.1:3015"):
            self.assertEqual(L.cache_ttl({"isYrc": True}), 7 * 86400)
            self.assertEqual(L.cache_ttl({"source": "lddc:kg"}), 7 * 86400)
            self.assertEqual(L.cache_ttl({"source": "ncm:inst"}), 7 * 86400)
            self.assertEqual(L.cache_ttl({"source": "ncm:lrc"}), L.SYNTH_RETRY_TTL)

    def test_disabled_provider_keeps_old_cache_policy(self):
        with mock.patch.object(L, "LDDC_URL", ""):
            self.assertEqual(L.cache_ttl({"source": "ncm:lrc"}), 7 * 86400)


if __name__ == "__main__":
    unittest.main()
