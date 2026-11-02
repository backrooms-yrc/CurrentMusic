"""阶段三（内容库）契约测试。

阶段三覆盖歌单 / 专辑 / 歌手 / MV / 视频 / 相似推荐，共 90 条。
这里按**分级**逐条钉死。风险比阶段二更高：

- T2 写操作 19 条（建歌单 / 改名 / 改描述 / 改标签 / 隐私 / 增删歌 /
  收藏歌单 / 收藏 MV / 收藏视频 / 导入任务），分级错了会直接改用户网易云账号的数据；
- T1 账号读 17 条（收藏列表、关注歌手的新作、UGC 百科、导入任务状态），
  绝不允许落到 SVIP 档去读服务端账号的数据；
- T0 54 条是公开目录/详情/相似推荐，应当无需登录即可访问。

另外钉两条**门禁**：阶段三已启用可转发，阶段四仍被挡住（防止提前放量）。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_registry as reg  # noqa: E402

# 公开只读：目录 / 榜单 / 详情 / 相似推荐
P3_T0 = [
    "/album", "/album/detail", "/album/detail/dynamic",
    "/album/list", "/album/list/style", "/album/new",
    "/album/newest", "/album/privilege", "/album/songsaleboard",
    "/artist/album", "/artist/desc", "/artist/detail",
    "/artist/detail/dynamic", "/artist/fans", "/artist/follow/count",
    "/artist/list", "/artist/mv", "/artist/songs",
    "/artist/top/song", "/artist/video", "/artists",
    "/mlog/music/rcmd", "/mlog/to/video", "/mlog/url",
    "/mv/all", "/mv/detail", "/mv/detail/info",
    "/mv/exclusive/rcmd", "/mv/first", "/mv/url",
    "/playlist/category/list", "/playlist/catlist", "/playlist/detail",
    "/playlist/detail/dynamic", "/playlist/detail/rcmd/get", "/playlist/highquality/tags",
    "/playlist/hot", "/playlist/subscribers", "/playlist/track/all",
    "/related/allvideo", "/related/playlist", "/simi/artist",
    "/simi/mv", "/simi/playlist", "/simi/song",
    "/simi/user", "/video/category/list", "/video/detail",
    "/video/detail/info", "/video/group", "/video/group/list",
    "/video/timeline/all", "/video/timeline/recommend", "/video/url",
]

# 账号只读：收藏列表、关注歌手新作、UGC 百科、导入任务状态
P3_T1 = [
    "/album/sublist", "/artist/new/mv", "/artist/new/song",
    "/artist/new/song/mv/list/v2", "/artist/new/song/playall", "/artist/sublist",
    "/mv/sublist", "/playlist/import/task/status", "/playlist/mylike",
    "/playlist/video/recent", "/ugc/album/get", "/ugc/artist/get",
    "/ugc/artist/search", "/ugc/detail", "/ugc/mv/get",
    "/ugc/song/get", "/ugc/user/devote",
]

# 账号写：歌单增删改、收藏（专辑/歌手/MV/歌单）、加删歌曲
P3_T2 = [
    "/album/sub", "/artist/sub", "/mv/sub",
    "/playlist/cover/update", "/playlist/create", "/playlist/delete",
    "/playlist/desc/update", "/playlist/import/name/task/create", "/playlist/name/update",
    "/playlist/order/update", "/playlist/privacy", "/playlist/subscribe",
    "/playlist/tags/update", "/playlist/track/add", "/playlist/track/delete",
    "/playlist/tracks", "/playlist/update", "/playlist/update/playcount",
    "/video/sub",
]


class TestP3SafetyInvariants(unittest.TestCase):
    def test_public_reads_are_t0(self):
        for p in P3_T0:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T0, f"{p} 是目录类读，应为 T0 而不是 {e[0]}")

    def test_account_reads_are_t1(self):
        for p in P3_T1:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T1, f"{p} 是账号维度读，应为 T1 而不是 {e[0]}")

    def test_writes_are_t2(self):
        for p in P3_T2:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T2, f"{p} 是写操作，应为 T2 而不是 {e[0]}")

    def test_no_write_leaks_into_readonly_tiers(self):
        """写操作绝不允许出现在 T0/T1/T3——那会用服务端或用户 cookie 直接改数据。"""
        for p in P3_T2:
            self.assertNotIn(reg.entry(p)[0], (reg.T0, reg.T1, reg.T3), p)

    def test_collect_endpoints_are_writes_not_reads(self):
        """收藏类（sub/subscribe）语义是写，最容易因路径含 'list' 被误判成读。"""
        for p in ["/album/sub", "/artist/sub", "/mv/sub", "/video/sub", "/playlist/subscribe"]:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T2, f"{p} 是收藏写操作，应为 T2 而不是 {e[0]}")


class TestP3PhaseGate(unittest.TestCase):
    def test_phase3_enabled_and_forwardable(self):
        self.assertGreaterEqual(reg.ENABLED_PHASE, 3)
        for p in P3_T0 + P3_T1 + P3_T2:
            self.assertTrue(reg.is_forwardable(p), f"{p} 阶段三应已可转发")

    def test_phase4_still_gated(self):
        if reg.ENABLED_PHASE >= 4:
            self.skipTest("已推进到阶段四")
        for p in ["/user/record", "/user/follows", "/record/recent/song", "/vip/info", "/yunbei/info"]:
            self.assertFalse(reg.is_forwardable(p), f"{p} 属阶段四，不应已启用")

    def test_phase3_count_matches_plan(self):
        """阶段三应为 90 条（计划口径）；数量变动必须同步文档。"""
        n = sum(1 for _t, _ttl, ph in reg.REGISTRY.values() if ph == 3)
        self.assertEqual(n, 90, f"阶段三条数变为 {n}，请同步 docs/api-5-phase-plan.md")


if __name__ == "__main__":
    unittest.main(verbosity=2)
