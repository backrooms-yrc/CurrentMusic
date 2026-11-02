"""阶段四（账号、社交与听歌足迹）契约测试。

阶段四覆盖账号资料 / 登录注册验证码 / 关系链 / 动态话题 / 消息私信 / 听歌足迹 /
设备管理 / 用户云盘与电台 / 用户歌单与播放记录 / 签到，共 92 条。分级比例与前三阶段
**相反**：这里 T1 账号读占多数（53 条），T2 写 22 条，另有 18 条 T3 敏感接口。

三条风险与对应的断言：

1. **T3 不得可转发**。18 条登录/验证码/注册/换绑必须走项目专用入口（/ncmbind/*），
   经泛化转发会绕过二次确认与审计（`is_forwardable` 必须为 False）。
2. **写操作不得落进 T1**。本阶段审计出 3 条"名字像读、上游是写"的接口
   （`/daily_signin` 签到、`/follow` 关注、`/activate/init/profile` 初始化昵称），
   它们若停在 T1 就会**绕过 T2 的 confirm=1 与审计**，因此单独钉死。
3. **账号读不得落进 T0**。T0 用服务端 SVIP 档，落错一条 = 泄露主账号数据。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_ncm_registry as reg  # noqa: E402

# 公开只读（2）：话题详情类
P4_T0 = [
    "/topic/detail", "/topic/detail/event/hot",
]

# 账号只读（53）：记忆/足迹/消息/关系链/资料——必须用调用者自己的 cookie
P4_T1 = [
    "/cellphone/existence/check", "/device/list", "/event", "/get/userids",
    "/history/recommend/songs", "/history/recommend/songs/detail",
    "/listen/data/realtime/report", "/listen/data/report", "/listen/data/song/play/rank",
    "/listen/data/today/song", "/listen/data/total", "/listen/data/year/report",
    "/msg/comments", "/msg/notices", "/msg/private", "/msg/private/history",
    "/msg/recentcontact", "/nickname/check", "/pl/count", "/recent/listen/list",
    "/record/recent/album", "/record/recent/dj", "/record/recent/playlist",
    "/record/recent/song", "/record/recent/video", "/record/recent/voice", "/summary/annual",
    "/user/account", "/user/audio", "/user/cloud", "/user/cloud/detail",
    "/user/comment/history", "/user/detail", "/user/detail/new", "/user/dj", "/user/event",
    "/user/event/all", "/user/follow/mixed", "/user/followeds", "/user/follows", "/user/level",
    "/user/medal", "/user/mutualfollow/get", "/user/playlist", "/user/playlist/collect",
    "/user/playlist/create", "/user/record", "/user/social/status", "/user/social/status/rcmd",
    "/user/social/status/support",
]

# 账号写（22）：关注/签到/发消息/改资料/删动态/设备下线/云盘删除
P4_T2 = [
    "/activate/init/profile", "/avatar/upload", "/daily_signin", "/device/kickoff",
    "/deviceinfo/center/upload", "/event/del", "/event/forward", "/event/privacy", "/follow",
    "/msg/forwards", "/send/album", "/send/playlist", "/send/song", "/send/text",
    "/sign/happy/info", "/signin/progress", "/topic/sublist", "/user/binding",
    "/user/cloud/del", "/user/social/status/edit", "/user/subcount", "/user/update",
]

# 敏感（18）：登录/验证码/注册/换绑/设置——**禁止**经泛化转发
P4_T3 = [
    "/captcha/safe/sent", "/captcha/sent", "/captcha/sent/v1", "/captcha/verify", "/login",
    "/login/cellphone", "/login/qr/check", "/login/qr/create", "/login/qr/key",
    "/login/refresh", "/login/status", "/logout", "/rebind", "/register/anonimous",
    "/register/cellphone", "/setting", "/user/bindingcellphone", "/user/replacephone",
]

# 名字像读、上游其实是写的三兄弟（本阶段审计新发现）
P4_HIDDEN_WRITES = ["/daily_signin", "/follow", "/activate/init/profile"]


class TestP4SafetyInvariants(unittest.TestCase):
    def test_public_reads_are_t0(self):
        for p in P4_T0:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T0, f"{p} 是公开读，应为 T0 而不是 {e[0]}")

    def test_account_reads_are_t1(self):
        for p in P4_T1:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T1,
                             f"{p} 是账号维度读，必须用调用者自己的 cookie（T1），"
                             f"落成 {reg.T1 and e[0]} 会把主账号数据暴露出去")

    def test_writes_are_t2(self):
        for p in P4_T2:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T2, f"{p} 是写操作，应为 T2 而不是 {e[0]}")

    def test_hidden_writes_are_t2_not_t1(self):
        """这三条的路径名/文档标题都像读，但上游是 POST 写：
        停在 T1 会绕过 T2 的 confirm=1 + 审计（签到、关注、初始化昵称都会被执行两次）。"""
        for p in P4_HIDDEN_WRITES:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T2, f"{p} 上游是写操作，必须是 T2（当前 {e[0]}）")

    def test_sensitive_paths_are_t3(self):
        for p in P4_T3:
            e = reg.entry(p)
            self.assertIsNotNone(e, f"{p} 未登记")
            self.assertEqual(e[0], reg.T3, f"{p} 属登录/验证码/换绑，必须是 T3")

    def test_account_scope_never_lands_on_svip_tier(self):
        """账号态（T1/T2/T3）一律不能是 T0——T0 会注入服务端 SVIP cookie。"""
        for p in P4_T1 + P4_T2 + P4_T3:
            self.assertNotEqual(reg.entry(p)[0], reg.T0, p)

    def test_device_kickoff_is_a_write(self):
        """设备下线会踢掉登录态，语义是写。"""
        self.assertEqual(reg.entry("/device/kickoff")[0], reg.T2)


class TestP4PhaseGate(unittest.TestCase):
    def test_phase4_enabled_and_forwardable(self):
        self.assertGreaterEqual(reg.ENABLED_PHASE, 4)
        for p in P4_T0 + P4_T1 + P4_T2:
            self.assertTrue(reg.is_forwardable(p), f"{p} 阶段四应已可转发")

    def test_sensitive_paths_stay_unforwardable(self):
        """阶段推进**不得**让 T3 变得可转发——这是分级与阶段两道闸门的独立性。"""
        for p in P4_T3:
            self.assertFalse(reg.is_forwardable(p), f"{p} 是 T3，任何阶段都不该可转发")

    def test_phase5_still_gated(self):
        if reg.ENABLED_PHASE >= 5:
            self.skipTest("已推进到阶段五")
        for p in ["/vip/info", "/yunbei/info", "/dj/detail", "/program/recommend"]:
            self.assertFalse(reg.is_forwardable(p), f"{p} 属阶段五，不应已启用")

    def test_phase4_count_matches_plan(self):
        """阶段四应为 92 条（计划口径）；数量变动必须同步 docs/api-5-phase-plan.md。"""
        n = sum(1 for _t, _ttl, ph in reg.REGISTRY.values() if ph == 4)
        self.assertEqual(n, 92, f"阶段四条数变为 {n}，请同步文档")


if __name__ == "__main__":
    unittest.main(verbosity=2)
