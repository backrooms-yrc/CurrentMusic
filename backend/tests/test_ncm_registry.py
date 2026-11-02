"""阶段一 NCM 登记层契约测试（纯本地，不打上游、不碰生产库）。

运行：
    python3 -m unittest discover -s backend/tests -v

覆盖两类断言：
  1. 安全不变量——写操作绝不在 T0（T0 会注入服务端 SVIP cookie）
  2. 阶段一契约——45 条接口必须已登记、为 T0、且阶段已启用
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_gateway as gw          # noqa: E402
import cm_ncm_registry as reg        # noqa: E402

# 阶段一交付的 39 条（35 T0 公开只读 + 3 T1 账号读 + 1 T2 写）。改动此表必须同步文档。
PHASE1_T0 = [
    "/banner", "/calendar",
    "/cloudsearch", "/countries/code/list", "/homepage/block/page",
    "/homepage/dragon/ball", "/personalized",
    "/personalized/djprogram", "/personalized/mv", "/personalized/newsong",
    "/personalized/privatecontent", "/personalized/privatecontent/list",
    "/search", "/search/default",
    "/search/hot", "/search/hot/detail",
    "/search/suggest", "/search/suggest/pc", "/style/album", "/style/artist",
    "/style/detail", "/style/list", "/style/playlist",
    "/style/song", "/top/album", "/top/artists", "/top/list", "/top/mv",
    "/top/playlist", "/top/playlist/highquality", "/top/song", "/toplist",
    "/toplist/artist", "/toplist/detail", "/toplist/detail/v2",
]
# 账号态读：必须用调用者自己的网易云 cookie，不能走 SVIP 档
PHASE1_T1 = ["/recommend/resource", "/recommend/songs", "/style/preference"]
PHASE1_T2 = ["/recommend/songs/dislike"]

# 不可达：上游实例本身不提供该功能（实测恒 502）→ 不进登记表
UNREACHABLE = ["/chart/detail", "/chart/song/detail"]

# 长尾工具类：有真实能力但无独立界面场景，排到 P5，**不排除出分母**
LATE_TAIL = ["/batch", "/lbs/city/code", "/search/match", "/search/multimatch"]

# 必须被拒绝的敏感路径（T3）
T3_MUST_REJECT = [
    "/login", "/login/cellphone", "/login/status", "/logout",
    "/register/cellphone", "/captcha/sent", "/captcha/verify",
    "/rebind", "/user/replacephone", "/setting",
]


class TestSafetyInvariants(unittest.TestCase):
    """生成期不变量在产物上的独立复核——防止有人手改登记表绕过生成器。"""

    def test_no_write_endpoint_is_t0(self):
        """/recommend/songs/dislike 等写操作不得处于 T0（SVIP 档）。"""
        for path, (tier, _ttl, _phase) in reg.REGISTRY.items():
            if tier != reg.T0:
                continue
            self.assertNotIn(path, reg.WRITE_EXACT if hasattr(reg, "WRITE_EXACT") else (), path)

    def test_known_writes_are_not_t0(self):
        writes = [
            "/comment", "/cloud", "/cloud/match", "/playlist/tracks", "/fm_trash",
            "/comment/reply", "/share/resource", "/hug/comment",
            "/dj/difm/channel/unsubscribe", "/vip/growthpoint/get",
            "/vip/growthpoint/getall", "/digitalAlbum/ordering",
            "/song/like", "/comment/like", "/playlist/create", "/playlist/delete",
            "/artist/sub", "/album/sub", "/mv/sub", "/video/sub", "/scrobble",
        ]
        for p in writes:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertNotEqual(e[0], reg.T0, f"{p} 是写操作，不能落在 T0（会注入 SVIP cookie）")

    def test_account_reads_are_not_t0(self):
        """账号态读必须走用户自己的 cookie，不能是 T0。"""
        acct = [
            "/likelist", "/song/like/check", "/recommend/songs",
            "/song/purchased", "/song/downlist", "/song/monthdownlist",
            "/song/lyrics/mark", "/song/lyrics/mark/user/page",
            "/artist/sublist", "/album/sublist", "/mv/sublist", "/dj/sublist",
            "/user/cloud", "/user/cloud/detail", "/playlist/mylike",
            "/playlist/video/recent", "/music/first/listen/info",
            "/personal_fm", "/personal/fm/mode",
        ]
        for p in acct:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T1, f"{p} 是账号态读，应为 T1 而不是 {e[0]}")

    def test_t3_paths_rejected(self):
        for p in T3_MUST_REJECT:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T3, f"{p} 应为 T3")
            self.assertFalse(reg.is_forwardable(p), f"{p} 不应允许泛化转发")


class TestPhase1Contract(unittest.TestCase):
    def test_phase1_t0_registered_and_enabled(self):
        self.assertGreaterEqual(reg.ENABLED_PHASE, 1)
        for p in PHASE1_T0:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"阶段一接口 {p} 未登记")
            tier, _ttl, phase = e
            self.assertEqual(tier, reg.T0, f"{p} 应为 T0")
            self.assertEqual(phase, 1, f"{p} 应属阶段一")
            self.assertTrue(reg.is_forwardable(p), f"{p} 应可转发")

    def test_phase1_t1_registered_and_enabled(self):
        for p in PHASE1_T1:
            tier, _ttl, phase = reg.entry(p)
            self.assertEqual(tier, reg.T1, f"{p} 是账号态读应为 T1")
            self.assertEqual(phase, 1)
            self.assertTrue(reg.is_forwardable(p))

    def test_phase1_write_is_t2_and_enabled(self):
        for p in PHASE1_T2:
            tier, _ttl, phase = reg.entry(p)
            self.assertEqual(tier, reg.T2, f"{p} 是写操作应为 T2")
            self.assertEqual(phase, 1)
            self.assertTrue(reg.is_forwardable(p))

    def test_phase1_has_no_t3(self):
        for p in PHASE1_T0 + PHASE1_T1 + PHASE1_T2:
            self.assertNotEqual(reg.entry(p)[0], reg.T3)

    def test_unreachable_paths_are_not_registered(self):
        """上游不可达的接口不应登记：登记了只会对外暴露一个必然失败的入口。"""
        for p in UNREACHABLE:
            self.assertIsNone(reg.entry(p), f"{p} 上游不可达，不应登记")
            self.assertFalse(reg.is_forwardable(p))

    def test_late_tail_stays_in_target_but_not_phase1(self):
        """长尾工具类必须留在分母里（排除它们只是让数字好看），并排到 P5。

        阶段五启用后它们已可转发，所以"不可转发"这一半只在阶段五尚未启用时校验
        （与 P3 测试里的 `test_phase4_still_gated` 同一处理方式：阶段推进时自动让位）。
        """
        for p in LATE_TAIL:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 不应被排除出登记表")
            self.assertEqual(e[2], 5, f"{p} 应排在 P5")
            if reg.ENABLED_PHASE < 5:
                self.assertFalse(reg.is_forwardable(p), f"{p} 阶段未启用，不应可转发")
            else:
                self.assertTrue(reg.is_forwardable(p), f"{p} 阶段五已启用，应可转发")

    def test_later_phases_are_gated(self):
        """未启用阶段的接口不应对外暴露。"""
        if reg.ENABLED_PHASE >= 2:
            self.skipTest("已推进到阶段二")
        for p in ["/cloud", "/likelist", "/album/detail", "/comment"]:
            self.assertGreater(reg.entry(p)[2], reg.ENABLED_PHASE, f"{p} 阶段应大于已启用阶段")
            self.assertFalse(reg.is_forwardable(p), f"{p} 属后续阶段，不应已启用")


class TestStripIdentity(unittest.TestCase):
    def test_strips_nested_identity_keys(self):
        payload = {
            "code": 200,
            "account": {"id": 1},
            "bindings": [{"mobile": "138"}],
            "data": {"list": [{"name": "x", "mobile": "139", "keep": 1}]},
        }
        out = reg.strip_identity(payload)
        self.assertNotIn("account", out)
        self.assertNotIn("bindings", out)
        self.assertEqual(out["code"], 200)
        self.assertEqual(out["data"]["list"][0]["keep"], 1)
        self.assertNotIn("mobile", out["data"]["list"][0])

    def test_keeps_normal_catalog_fields(self):
        payload = {"code": 200, "list": [{"id": 1, "name": "歌", "artists": []}]}
        self.assertEqual(reg.strip_identity(payload), payload)

    def test_family_granularity(self):
        self.assertEqual(reg.family("/top/playlist"), "/top/playlist")
        self.assertEqual(reg.family("/song/url/v1"), "/song/url")


class TestGatewayHelpers(unittest.TestCase):
    def test_reserved_params_dropped(self):
        params = gw.normalize_params("/toplist", {"cookie": "MUSIC_U=evil", "token": "t",
                                                  "realIP": "1.2.3.4", "limit": "10"}, "GET")
        self.assertNotIn("cookie", params)
        self.assertNotIn("token", params)
        self.assertEqual(params["limit"], "10")

    def test_timestamp_added_for_writes_only(self):
        self.assertNotIn("timestamp", gw.normalize_params("/toplist", {}, "GET"))
        self.assertIn("timestamp", gw.normalize_params("/comment", {}, "POST"))

    def test_empty_values_dropped(self):
        params = gw.normalize_params("/search", {"keywords": "", "limit": "5"}, "GET")
        self.assertNotIn("keywords", params)

    def test_cache_key_is_order_independent(self):
        a = gw.cache_key("/toplist", {"a": "1", "b": "2"})
        b = gw.cache_key("/toplist", {"b": "2", "a": "1"})
        self.assertEqual(a, b)
        self.assertNotEqual(a, gw.cache_key("/toplist", {"a": "1", "b": "3"}))


class TestFamilyBreaker(unittest.TestCase):
    def test_opens_after_threshold_and_is_per_family(self):
        b = gw.FamilyBreaker(threshold=3, cooldown=60)
        for _ in range(3):
            self.assertTrue(b.allow("/song/url"))
            b.record_failure("/song/url")
        self.assertFalse(b.allow("/song/url"), "达到阈值应熔断")
        self.assertTrue(b.allow("/top/playlist"), "其它接口族不应被连累")

    def test_success_resets(self):
        b = gw.FamilyBreaker(threshold=3, cooldown=60)
        b.record_failure("/a/b")
        b.record_failure("/a/b")
        b.record_success("/a/b")
        for _ in range(2):
            b.record_failure("/a/b")
        self.assertTrue(b.allow("/a/b"), "成功一次后计数应清零")

    def test_cooldown_expires(self):
        b = gw.FamilyBreaker(threshold=1, cooldown=0.05)
        b.record_failure("/x/y")
        self.assertFalse(b.allow("/x/y"))
        import time
        time.sleep(0.06)
        self.assertTrue(b.allow("/x/y"), "冷却结束应半开放行")


if __name__ == "__main__":
    unittest.main(verbosity=2)
