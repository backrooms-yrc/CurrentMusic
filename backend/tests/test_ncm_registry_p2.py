"""阶段二（播放内核与歌曲深度）契约测试。

与阶段一测试同源同口径：只断言**分级正确性**与**阶段门禁**，不打上游。
阶段二的特点：写操作显著增多（评论增删改/云盘/打卡/摘录），分级错了会误改用户账号，
所以这里对「写 → T2」「账号读 → T1」「目录读 → T0」逐条钉死。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_registry as reg  # noqa: E402

# 写操作：必须 T2（用户 cookie + confirm=1 + 审计）
P2_WRITES = [
    "/comment", "/comment/add", "/comment/delete", "/comment/reply",
    "/comment/like", "/comment/report", "/hug/comment",
    "/like", "/like/v1", "/song/like", "/resource/like", "/share/resource",
    "/scrobble", "/scrobble/v1", "/relay/play/state/submit",
    "/cloud", "/cloud/import", "/cloud/match",
    "/cloud/upload/token", "/cloud/upload/complete",
    "/song/lyrics/mark/add", "/song/lyrics/mark/del", "/song/order/update",
]

# 账号维度读：必须 T1（用户自己的 cookie，绝不走 SVIP 档）
P2_ACCOUNT_READS = [
    "/likelist", "/song/like/check", "/song/lyrics/mark", "/song/lyrics/mark/user/page",
    "/song/purchased", "/song/singledownlist", "/song/downlist", "/song/monthdownlist",
    "/song/cloud/download", "/cloud/lyric/get", "/playmode/song/vector",
    "/music/first/listen/info",
]

# 目录类读：T0
P2_PUBLIC_READS = [
    "/comment/music", "/comment/album", "/comment/playlist", "/comment/mv",
    "/comment/dj", "/comment/video", "/comment/hot", "/comment/floor",
    "/comment/new", "/comment/info/list", "/comment/hug/list", "/comment/event",
    "/song/detail", "/song/url", "/song/url/v1", "/song/url/v1/302", "/song/url/match",
    "/song/download/url", "/song/download/url/v1",
    "/song/chorus", "/song/creators", "/song/music/detail", "/song/red/count",
    "/song/simi/get", "/song/dynamic/cover", "/song/copyright/rcmd",
    "/song/wiki/info", "/song/wiki/summary",
    "/lyric", "/lyric/new", "/sheet/list", "/sheet/preview",
    "/check/music", "/audio/match",
]


class TestP2SafetyInvariants(unittest.TestCase):
    def test_writes_are_t2(self):
        for p in P2_WRITES:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T2, f"{p} 是写操作，应为 T2 而不是 {e[0]}")

    def test_account_reads_are_t1(self):
        for p in P2_ACCOUNT_READS:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T1, f"{p} 是账号维度读，应为 T1 而不是 {e[0]}")

    def test_public_reads_are_t0(self):
        for p in P2_PUBLIC_READS:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T0, f"{p} 是目录类读，应为 T0 而不是 {e[0]}")

    def test_no_write_leaks_into_readonly_tiers(self):
        """写操作绝不允许出现在 T0/T1——那会用服务端或用户 cookie 直接改数据。"""
        for p in P2_WRITES:
            self.assertNotIn(reg.entry(p)[0], (reg.T0, reg.T1, reg.T3), p)


# 上游实现为占位桩（模块源码直接 return 空 data），无功能可覆盖 → 不进登记表
P2_UNREACHABLE = ["/song/url/ncmget"]


class TestP2PhaseGate(unittest.TestCase):
    def test_stub_endpoints_not_registered(self):
        for p in P2_UNREACHABLE:
            self.assertIsNone(reg.entry(p), f"{p} 是空操作桩，不应登记")
            self.assertFalse(reg.is_forwardable(p))

    def test_phase2_enabled_and_forwardable(self):
        self.assertGreaterEqual(reg.ENABLED_PHASE, 2)
        for p in (P2_PUBLIC_READS + P2_ACCOUNT_READS + P2_WRITES):
            self.assertTrue(reg.is_forwardable(p), f"{p} 阶段二应已可转发")

    def test_phase3_still_gated(self):
        if reg.ENABLED_PHASE >= 3:
            self.skipTest("已推进到阶段三")
        for p in ["/playlist/track/all", "/album/sub", "/artist/sub", "/mv/sub",
                  "/video/url", "/ugc/song/get", "/simi/song"]:
            self.assertFalse(reg.is_forwardable(p), f"{p} 属阶段三，不应已启用")

    def test_phase2_count_matches_plan(self):
        """阶段二应为 70 条（计划口径）；数量变动必须同步文档。"""
        n = sum(1 for _t, _ttl, ph in reg.REGISTRY.values() if ph == 2)
        self.assertEqual(n, 69, f"阶段二条数变为 {n}，请同步 docs/api-5-phase-plan.md")


if __name__ == "__main__":
    unittest.main(verbosity=2)
