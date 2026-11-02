#!/usr/bin/env python3
"""播放抗卡顿策略的纯逻辑回归测试（v1.28.23）。

只测**不依赖网络**的部分：档位上限（maxBr）语义、择优排序、CDN 边缘族识别与
健康度、解析单飞。这些都是「卡顿治理」里最容易悄悄写错、且出错后很难在真机上
复现的地方（例如把 maxBr 量化方向写反 —— 用户要 ≤1.5Mbps 却拿到 5.2Mbps 母带）。

    python3 -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_stream as S  # noqa: E402


def song(br, type_="flac", size=1000, level=""):
    return {"url": f"https://m801.music.126.net/x/{level or br}.flac",
            "br": br, "type": type_, "size": size, "level": level}


class TestMaxBr(unittest.TestCase):
    """码率上限：向下量化到档位边界（保证不会超过调用方给的上限）。"""

    def test_zero_and_negative_mean_unlimited(self):
        for v in (0, None, "", -1, "abc"):
            self.assertEqual(S.quantize_max_br(v), 0, v)

    def test_quantize_rounds_down_to_tier(self):
        # 1.5Mbps 落在无损档名义码率（907568）以下 → 取无损档，绝不取 1.6M 的 hires
        self.assertEqual(S.quantize_max_br(1_500_000), S.NOMINAL_BR["lossless"])
        # 正好落在边界上则取该档
        self.assertEqual(S.quantize_max_br(S.NOMINAL_BR["hires"]), S.NOMINAL_BR["hires"])
        self.assertEqual(S.quantize_max_br(S.NOMINAL_BR["exhigh"]), S.NOMINAL_BR["exhigh"])
        # 比最低档还低 → 兜到最低档（standard），不返回 0
        self.assertEqual(S.quantize_max_br(1000), S.NOMINAL_BR["standard"])
        # 超过母带档 → 夹到母带档
        self.assertEqual(S.quantize_max_br(99_999_999), S.NOMINAL_BR["jymaster"])

    def test_quantized_value_never_exceeds_request(self):
        for v in (100_000, 300_000, 800_000, 1_200_000, 2_000_000, 3_000_000, 4_000_000):
            q = S.quantize_max_br(v)
            self.assertLessEqual(q, max(v, S.NOMINAL_BR["standard"]), f"maxBr={v} → {q}")

    def test_allowed_levels_and_probe_tiers(self):
        self.assertEqual(S.probe_tiers(0), S.PROBE_TIERS)          # 不限：与旧实现一致
        allow = S.allowed_levels(S.NOMINAL_BR["lossless"])
        self.assertEqual(allow, ("lossless", "exhigh", "standard"))
        self.assertEqual(S.probe_tiers(S.NOMINAL_BR["lossless"]), allow)
        # 上限低到只剩标准档时也必须探得到，不能变成空集合
        self.assertEqual(S.probe_tiers(S.NOMINAL_BR["standard"]), ("standard",))

    def test_within_is_level_based_not_measured(self):
        # 按档位判定：实测码率有漂移（无损档实测 0.79~1.0Mbps 都见过），
        # 按实测值过滤会把用户想要的无损误伤掉。
        self.assertTrue(S.within("lossless", S.NOMINAL_BR["lossless"]))
        self.assertFalse(S.within("sky", S.NOMINAL_BR["lossless"]))
        self.assertTrue(S.within("jymaster", 0))


class TestRanked(unittest.TestCase):
    """择优：与旧 best_level 同口径（码率 → 真无损 → 体积），并按上限过滤。"""

    def test_picks_max_bitrate(self):
        rows = [("jymaster", song(320_000, "mp3")), ("sky", song(1_971_214))]
        self.assertEqual(S.pick(rows, 0)[0], "sky")

    def test_flac_beats_mp3_at_equal_bitrate(self):
        rows = [("exhigh", song(320_000, "mp3")), ("lossless", song(320_000, "flac"))]
        self.assertEqual(S.pick(rows, 0)[0], "lossless")

    def test_ties_keep_probe_order(self):
        # 旧实现是「严格大于才替换」，所以并列时先探到的档位胜出；排序必须稳定。
        rows = [("jymaster", song(320_000, "mp3")), ("jyeffect", song(320_000, "mp3"))]
        self.assertEqual(S.pick(rows, 0)[0], "jymaster")

    def test_cap_filters_out_heavy_tiers(self):
        rows = [("jymaster", song(5_085_163)), ("sky", song(1_971_214)),
                ("lossless", song(907_568))]
        cap = S.quantize_max_br(1_000_000)          # → 907568，只允许无损及以下
        self.assertEqual(S.pick(rows, cap)[0], "lossless")
        self.assertEqual([lv for lv, _ in S.ranked(rows, cap)], ["lossless"])

    def test_none_results_are_ignored(self):
        rows = [("jymaster", None), ("sky", song(1_971_214))]
        self.assertEqual(S.pick(rows, 0)[0], "sky")
        self.assertEqual(S.pick([("jymaster", None)], 0), (None, None))

    def test_ranked_is_descending(self):
        rows = [("lossless", song(907_568)), ("jymaster", song(5_085_163)),
                ("sky", song(1_971_214))]
        self.assertEqual([lv for lv, _ in S.ranked(rows, 0)], ["jymaster", "sky", "lossless"])


class TestEdgeFamily(unittest.TestCase):
    """CDN 边缘族：跨族不可换，候选必须按当前边缘所在的族取。"""

    def test_host_helpers(self):
        self.assertEqual(S.host_of("https://m801.music.126.net/a/b.flac?x=1"), "m801.music.126.net")
        self.assertEqual(S.host_of("not a url"), "")
        self.assertEqual(S.normalize_host(" M7.MUSIC.126.NET "), "m7.music.126.net")
        self.assertEqual(S.normalize_host("https://m8.music.126.net/a/b.flac?x=1"), "m8.music.126.net")
        self.assertEqual(S.normalize_host("m701.music.126.net/x"), "m701.music.126.net")
        self.assertEqual(S.normalize_host(""), "")
        self.assertEqual(S.normalize_host("evil.com"), "evil.com")

    def test_with_host_rewrites_and_upgrades_scheme(self):
        out = S.with_host("http://m801.music.126.net/a/b.flac?a=1", "m703.music.126.net")
        self.assertTrue(out.startswith("https://m703.music.126.net/a/"))
        self.assertTrue(out.endswith("?a=1"))
        self.assertEqual(S.with_host("", "m703.music.126.net"), "")

    def test_two_families_are_distinct(self):
        two = S.edge_family("m7.music.126.net")
        three = S.edge_family("m801.music.126.net")
        self.assertTrue(two and three)
        self.assertFalse(set(two) & set(three), "两族不能有交集（跨族签名不通）")
        self.assertIn("m9.music.126.net", two)
        self.assertIn("m703.music.126.net", three)

    def test_candidates_stay_in_family(self):
        for h in S.edge_candidates("m7.music.126.net"):
            self.assertEqual(S.edge_family(h), S.edge_family("m7.music.126.net"))
        self.assertEqual(S.edge_candidates("m7.music.126.net"), ["m8.music.126.net", "m9.music.126.net"])
        # 未登记的边缘（例如只服务沉浸声的 m707）没有同族可换 → 空，绝不乱换
        self.assertEqual(S.edge_candidates("m707.music.126.net"), [])
        self.assertEqual(S.edge_candidates("m1.music.126.net"), [])
        self.assertEqual(S.edge_candidates("evil.com"), [])

    def test_is_edge_host(self):
        for h in ("m7.music.126.net", "m8.music.126.net", "m701.music.126.net", "m804.music.126.net"):
            self.assertTrue(S.is_edge_host(h), h)
        for h in ("evil.com", "m7.music.126.net.evil.com", "", "m7.example.com"):
            self.assertFalse(S.is_edge_host(h), h)


class TestEdgeHealth(unittest.TestCase):
    def setUp(self):
        self.h = S.EdgeHealth()

    def test_unknown_host_or_event_rejected(self):
        self.assertFalse(self.h.note("evil.com", "stall"))
        self.assertFalse(self.h.note("m7.music.126.net", "whatever"))
        self.assertTrue(self.h.note("m7.music.126.net", "stall"))

    def test_stall_marks_bad_and_ok_recovers(self):
        self.h.note("m7.music.126.net", "stall", now=1000.0)
        self.assertTrue(self.h.bad("m7.music.126.net", now=1001.0))
        self.h.note("m7.music.126.net", "ok", now=1002.0)
        self.assertFalse(self.h.bad("m7.music.126.net", now=1003.0))

    def test_penalty_grows_then_expires(self):
        self.h.note("m7.music.126.net", "stall", now=1000.0)
        self.h.note("m7.music.126.net", "stall", now=1001.0)
        s = self.h.snapshot(now=1001.0)["m7.music.126.net"]
        self.assertEqual(s["stalls"], 2)
        self.assertGreater(s["badRemainS"], self.h.BAD_BASE)
        self.assertFalse(self.h.bad("m7.music.126.net", now=1001.0 + self.h.BAD_MAX + 1))

    def test_old_stalls_fall_out_of_window(self):
        self.h.note("m7.music.126.net", "stall", now=1000.0)
        self.h.note("m7.music.126.net", "stall", now=1000.0 + self.h.STALL_WINDOW + 1)
        self.assertEqual(self.h.snapshot(now=1000.0 + self.h.STALL_WINDOW + 1)["m7.music.126.net"]["stalls"], 1)

    def test_rank_puts_complained_hosts_last(self):
        self.h.note("m7.music.126.net", "stall", now=1000.0)
        ranked = self.h.rank(["m7.music.126.net", "m8.music.126.net"], now=1000.0)
        self.assertEqual(ranked[0], "m8.music.126.net")

    def test_pick_edge_skips_current_and_unhealthy(self):
        self.h.note("m7.music.126.net", "stall", now=1000.0)
        hosts = ["m8.music.126.net", "m7.music.126.net", "m9.music.126.net"]
        self.assertEqual(S.pick_edge(hosts, current="m8.music.126.net", now=1000.0, health=self.h),
                         "m9.music.126.net")
        # 只有当前线可选时不换（宁可保持原样，也不许把地址弄丢）
        self.assertEqual(S.pick_edge(["m8.music.126.net"], current="m8.music.126.net", health=self.h), "")
        self.assertEqual(S.pick_edge([], current="", health=self.h), "")

    def test_host_table_is_bounded(self):
        h = S.EdgeHealth()
        h.MAX_HOSTS = 4
        for i in range(10):
            h.note(f"m70{i}.music.126.net", "ok")
        self.assertLessEqual(len(h.snapshot()), 4)


class TestEdgeCache(unittest.TestCase):
    def test_put_get_and_ttl(self):
        c = S.EdgeCache(ttl=10, cap=4)
        c.put("k", ["m7.music.126.net", "m8.music.126.net"])
        self.assertEqual(c.get("k"), ["m7.music.126.net", "m8.music.126.net"])
        c._data["k"] = (c._data["k"][0], time.time() - 11)
        self.assertIsNone(c.get("k"))

    def test_put_drops_non_edge_hosts(self):
        c = S.EdgeCache()
        c.put("k", ["evil.com", "m8.music.126.net"])
        self.assertEqual(c.get("k"), ["m8.music.126.net"])
        c.put("k2", ["evil.com"])
        self.assertIsNone(c.get("k2"))

    def test_lru_cap(self):
        c = S.EdgeCache(ttl=100, cap=4)
        for i in range(6):
            c.put(f"k{i}", ["m7.music.126.net"])
        self.assertLessEqual(c.size(), 4)


class TestSingleFlight(unittest.TestCase):
    def test_followers_share_one_run(self):
        sf = S.SingleFlight()
        calls = []

        def work():
            calls.append(1)
            time.sleep(0.15)
            return "v"

        import threading
        out = []
        ts = [threading.Thread(target=lambda: out.append(sf.do("k", work))) for _ in range(5)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(calls), 1, "同一 key 的并发调用只应执行一次")
        self.assertEqual(out, ["v"] * 5)

    def test_exception_propagates_to_followers(self):
        sf = S.SingleFlight()

        def boom():
            raise ValueError("上游炸了")

        import threading
        errs = []

        def run():
            try:
                sf.do("k", boom)
            except ValueError as e:
                errs.append(str(e))

        ts = [threading.Thread(target=run) for _ in range(3)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errs, ["上游炸了"] * 3)

    def test_key_is_released_after_run(self):
        sf = S.SingleFlight()
        self.assertEqual(sf.do("k", lambda: 1), 1)
        self.assertEqual(sf.do("k", lambda: 2), 2)
        self.assertEqual(sf.inflight(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
